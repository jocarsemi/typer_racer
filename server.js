/**
 * Servidor Type Racer
 * - Sirve index.html en la raíz
 * - Gestiona salas en memoria con Socket.IO
 * - Es la fuente de verdad del progreso y del ganador
 */

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname)); // sirve index.html
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/** Estructura de una sala:
 * {
 *   id, text,
 *   hostId,
 *   state: 'lobby'|'countdown'|'racing'|'finished',
 *   players: Map<socketId, { id, name, color, chars, finished, finishAt }>,
 *   winnerId: string|null
 * }
 */
const rooms = new Map();

const COLORS = ['#e74c3c','#3498db','#2ecc71','#f1c40f','#e67e22','#9b59b6','#fd79a8','#00cec9'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin caracteres ambiguos

function genRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, color: p.color, chars: p.chars, finished: p.finished };
}

function roomSnapshot(room) {
  return {
    id: room.id,
    state: room.state,
    hostId: room.hostId,
    textLength: room.text.length,
    players: [...room.players.values()].map(publicPlayer),
    winnerId: room.winnerId || null
  };
}

function broadcastRoom(room) {
  io.to(room.id).emit('room_update', roomSnapshot(room));
}

function broadcastRace(room) {
  io.to(room.id).emit('race_update', {
    players: [...room.players.values()].map(publicPlayer),
    winnerId: room.winnerId || null
  });
}

function cleanupIfEmpty(room) {
  if (room.players.size === 0) rooms.delete(room.id);
}

io.on('connection', (socket) => {

  // ---------- CREAR SALA (profesor) ----------
  socket.on('create_room', ({ text } = {}, cb) => {
    try {
      if (typeof text !== 'string' || !text.trim()) {
        return cb?.({ ok: false, error: 'El texto no puede estar vacío.' });
      }
      if (text.length > 5000) {
        return cb?.({ ok: false, error: 'Texto demasiado largo (máx. 5000).' });
      }

      const id = genRoomCode();
      const room = {
        id,
        text,
        hostId: socket.id,
        state: 'lobby',
        players: new Map(),
        winnerId: null
      };
      rooms.set(id, room);
      socket.join(id);
      socket.data.roomId = id;
      socket.data.isHost = true;

      cb?.({ ok: true, roomId: id });
      broadcastRoom(room);
    } catch (e) {
      cb?.({ ok: false, error: 'Error creando sala.' });
    }
  });

  // ---------- UNIRSE (jugador) ----------
  socket.on('join_room', ({ roomId, name, color } = {}, cb) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Sala no encontrada.' });
    if (room.state !== 'lobby') return cb?.({ ok: false, error: 'La carrera ya ha comenzado.' });

    const cleanName = String(name || '').trim().slice(0, 15);
    if (!cleanName) return cb?.({ ok: false, error: 'El nombre no puede estar vacío.' });
    if (!COLORS.includes(color)) return cb?.({ ok: false, error: 'Color no válido.' });

    // Nombre único (case-insensitive)
    for (const p of room.players.values()) {
      if (p.name.toLowerCase() === cleanName.toLowerCase())
        return cb?.({ ok: false, error: 'Ese nombre ya está en uso.' });
      if (p.color === color)
        return cb?.({ ok: false, error: 'Ese color ya está en uso.' });
    }

    const player = {
      id: socket.id,
      name: cleanName,
      color,
      chars: 0,
      finished: false,
      finishAt: null
    };
    room.players.set(socket.id, player);
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.isHost = false;

    cb?.({ ok: true, roomId: room.id, players: [...room.players.values()].map(publicPlayer), state: room.state });
    broadcastRoom(room);
  });

  // ---------- INICIAR CARRERA (host) ----------
  socket.on('start_race', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostId !== socket.id) return;
    if (room.state !== 'lobby') return;
    if (room.players.size === 0) return;

    // Reset por si acaso
    room.winnerId = null;
    for (const p of room.players.values()) {
      p.chars = 0;
      p.finished = false;
      p.finishAt = null;
    }

    // Cuenta atrás 3-2-1
    room.state = 'countdown';
    broadcastRoom(room);

    let n = 3;
    io.to(room.id).emit('countdown', { n });
    const tick = setInterval(() => {
      n--;
      if (n > 0) {
        io.to(room.id).emit('countdown', { n });
      } else {
        clearInterval(tick);
        if (!rooms.has(room.id)) return; // sala cerrada
        room.state = 'racing';
        io.to(room.id).emit('countdown', { n: 0 }); // GO
        io.to(room.id).emit('race_started', { text: room.text });
        broadcastRoom(room);
        broadcastRace(room);
      }
    }, 1000);
  });

  // ---------- PROGRESO DEL JUGADOR ----------
  socket.on('progress', ({ chars } = {}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state !== 'racing') return;
    const p = room.players.get(socket.id);
    if (!p || p.finished) return;

    const total = room.text.length;
    const safe = Math.max(0, Math.min(total, Number.isInteger(chars) ? chars : 0));

    // Solo avanzar (nunca retroceder por seguridad)
    if (safe > p.chars) p.chars = safe;

    if (p.chars >= total) {
      p.finished = true;
      p.finishAt = Date.now();
      if (!room.winnerId) {
        room.winnerId = p.id;
        io.to(room.id).emit('winner', { id: p.id, name: p.name });
      }
    }

    // ¿Todos han terminado? -> finished
    const allDone = [...room.players.values()].every(pl => pl.finished);
    if (allDone) room.state = 'finished';

    broadcastRace(room);
    if (allDone) broadcastRoom(room);
  });

  // ---------- REINICIAR (host) ----------
  socket.on('restart_race', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostId !== socket.id) return;

    room.state = 'lobby';
    room.winnerId = null;
    for (const p of room.players.values()) {
      p.chars = 0;
      p.finished = false;
      p.finishAt = null;
    }
    broadcastRoom(room);
    broadcastRace(room);
  });

  // ---------- EXPULSAR (host) ----------
  socket.on('kick', ({ playerId } = {}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostId !== socket.id) return;
    if (!room.players.has(playerId)) return;

    io.to(playerId).emit('kicked');
    const target = io.sockets.sockets.get(playerId);
    if (target) {
      target.leave(room.id);
      target.data.roomId = null;
    }
    room.players.delete(playerId);
    broadcastRoom(room);
    broadcastRace(room);
  });

  // ---------- SALIR / DESCONEXIÓN ----------
  socket.on('leave_room', () => {
    handleLeave(socket);
  });

  socket.on('disconnect', () => {
    handleLeave(socket);
  });

  function handleLeave(sock) {
    const room = rooms.get(sock.data.roomId);
    if (!room) return;

    // Si se va el host -> cierra la sala
    if (room.hostId === sock.id) {
      io.to(room.id).emit('room_closed', { message: 'El profesor ha cerrado la sala.' });
      io.in(room.id).socketsLeave(room.id);
      rooms.delete(room.id);
      return;
    }

    room.players.delete(sock.id);
    broadcastRoom(room);
    broadcastRace(room);
    cleanupIfEmpty(room);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor Type Racer en http://localhost:${PORT}`);
  console.log('Para probar en la misma red, usa la IP local de este equipo.');
});