export const formatUTC = (iso) => new Date(iso).toISOString().slice(0, 16).replace("T", " ");
