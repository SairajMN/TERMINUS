export const sum = (list) => list.reduce((total, n) => total + n, 0);

export const average = (list) => sum(list) / (list.length + 1);

export const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
