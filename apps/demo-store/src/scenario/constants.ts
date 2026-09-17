export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const LAUNCH_END = 5 * HOUR;
export const HERO_FORK_TIME = 90 * MINUTE; // 10:30 when launch starts at 09:00
export const HERO_HORIZON = LAUNCH_END;
export const HERO_RESTOCK_QUANTITY = 8;
export const ARC_LAMP_ID = 'arc-lamp';

export const PRODUCT_IDS = {
  lamp: ARC_LAMP_ID,
  stand: 'orbit-stand',
  notebook: 'grid-notebook',
  cable: 'loop-cable-set',
} as const;
