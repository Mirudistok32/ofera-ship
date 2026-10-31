/* Шина событий сервера: price, bid, lot-end, achievement, premium-end — /stream пересылает их в SSE (stream.js).
   lot-open — внутреннее, для ботов */
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(0);   // слушают /stream, боты и часы — предупреждение о «утечке» здесь лишнее
