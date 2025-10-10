// src/utils/fetchWithTimeout.js
const _fetch = (...args) => (typeof global.fetch === 'function'
  ? global.fetch(...args)
  : import('node-fetch').then(({ default: f }) => f(...args)))

async function fetchWithTimeout(resource, options = {}, ms = 25_000) {
  const { AbortController } = global
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), ms)
  try {
    return await _fetch(resource, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(id)
  }
}

module.exports = { fetchWithTimeout }
