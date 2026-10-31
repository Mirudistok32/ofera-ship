import type { Rarity } from './types';

/* Подписи редкостей. Цвет — в styles.css: класс rarity-<id> задаёт --rarity */
export const RARITIES: { id: Rarity; name: string; emoji: string }[] = [
  { id: 'common', name: 'обычный', emoji: '⚪' },
  { id: 'rare', name: 'редкий', emoji: '🔵' },
  { id: 'epic', name: 'эпический', emoji: '🟣' },
  { id: 'legendary', name: 'легендарный', emoji: '🟠' },
  { id: 'mythic', name: 'мифический', emoji: '🌈' },
];

export const rarityName = (id: Rarity) => RARITIES.find((r) => r.id === id)?.name ?? id;
