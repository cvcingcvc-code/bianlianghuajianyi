function required(key, value) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing required config: ${key}`);
  }
}

function isNumber(key, value, min, max) {
  const n = Number(value);
  if (Number.isNaN(n)) throw new Error(`Config ${key} must be a number, got: ${value}`);
  if (min !== undefined && n < min) throw new Error(`Config ${key} must be >= ${min}, got: ${n}`);
  if (max !== undefined && n > max) throw new Error(`Config ${key} must be <= ${max}, got: ${n}`);
  return n;
}

function maskSecret(str) {
  if (!str || str.length <= 8) return '***';
  return str.slice(0, 4) + '...' + str.slice(-4);
}

module.exports = { required, isNumber, maskSecret };
