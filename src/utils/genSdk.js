// src/utils/genSdk.js
let getGenModel = null
let usingNewGenAi = false

function initGenSdkIfNeeded() {
  if (getGenModel) return
  try {
    const { GoogleGenerativeAI } = require('google-genai')
    usingNewGenAi = true
    getGenModel = (apiKey, model) => new GoogleGenerativeAI({ apiKey }).getGenerativeModel({ model })
    return
  } catch (_) {}
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai')
    getGenModel = (apiKey, model) => new GoogleGenerativeAI(apiKey).getGenerativeModel({ model })
  } catch (_) {}
}

module.exports = { initGenSdkIfNeeded, getGenModel: () => getGenModel, usingNewGenAi: () => usingNewGenAi }
