// 📡 Socket.io client for the dispatch board.
//
// Replaces "every open board re-fetches /api/v1/tracking every 15 seconds" with
// "the server tells us when a truck actually moves". The board keeps a slow
// poll as a floor (see LiveFleetMap) because a socket that quietly dies must
// not leave a map frozen at yesterday's positions with no sign anything is
// wrong — a stale map is more dangerous than an obviously empty one.
//
// To be clear about the economics: this saves OUR server load and cuts latency.
// It does not reduce Google Maps spend — map loads are billed, marker moves are
// not. The Google cost is Directions/Distance Matrix, handled by mapsCache.
import { io, type Socket } from 'socket.io-client';
import { API_BASE } from './apiBase';

export interface GpsFixEvent {
  trip_id: string;
  lat: number;
  lng: number;
  speed_kmh: number | null;
  source: string;
  recorded_at: string;
}

let socket: Socket | null = null;

/** Connect (or reuse) the shared fleet socket. Returns null if there is no
 *  token — an unauthenticated socket is refused at handshake anyway. */
export function connectFleetSocket(): Socket | null {
  const token = localStorage.getItem('prasad_token');
  if (!token) return null;
  if (socket?.connected) return socket;

  socket = io(API_BASE, {
    path: '/socket.io',
    auth: { token },
    // websocket first; polling is the fallback that keeps this working through
    // the production nginx until it forwards Upgrade/Connection headers.
    transports: ['websocket', 'polling'],
    reconnectionAttempts: 8,
    reconnectionDelay: 1500,
    reconnectionDelayMax: 15000,
    timeout: 8000,
  });

  return socket;
}

export function disconnectFleetSocket() {
  socket?.disconnect();
  socket = null;
}

export const fleetSocket = () => socket;
