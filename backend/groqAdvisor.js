const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '.env') });

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';

/**
 * Generate AI Clinical Pharmacist Relocation Brief using Groq
 */
async function generateClinicalBrief({ sourceFridgeName, targetFridgeName, currentTemp, predictedTemp30Min, batches, reason }) {
  if (!GROQ_API_KEY) {
    return {
      source: 'LOCAL_HEURISTIC',
      text: `Automated Protocol: Due to ${reason}, temperature is projected to reach ${predictedTemp30Min}°C. Immediate evacuation of ${batches.length} batch(es) to ${targetFridgeName} is recommended to preserve vaccine integrity.`
    };
  }

  const prompt = `
You are the AI Clinical Cold-Chain Safety Specialist at a national biomedical facility.
A critical thermal breach warning has triggered:
- Source Compartment: ${sourceFridgeName} (Current: ${currentTemp}°C, 30m Forecast: ${predictedTemp30Min}°C)
- Safe Range: 2.0°C to 8.0°C
- Target Safe Compartment: ${targetFridgeName}
- Batches at Risk: ${batches.map(b => `${b.name} (${b.type}, remaining heat budget: ${b.remainingMinutes}m)`).join(', ')}
- Trigger Reason: ${reason}

Write a concise, professional 3-sentence Clinical Emergency Action Advisory for the duty Pharmacist explaining the molecular risk (e.g., protein denaturation, mRNA lipid nanoparticle breakdown) and directing the immediate 1-click transfer.
`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: 'You are an expert biomedical cold-chain AI specialist. Provide sharp, professional, clinically rigorous guidance.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 200
      })
    });

    const data = await res.json();
    if (data.choices && data.choices[0]?.message?.content) {
      return {
        source: 'GROQ_AI_' + GROQ_MODEL,
        text: data.choices[0].message.content.trim()
      };
    }
  } catch (err) {
    console.error('[Groq AI] Request error:', err.message);
  }

  return {
    source: 'LOCAL_FALLBACK',
    text: `Clinical Notice: Thermal trajectory breaches safe limits (${predictedTemp30Min}°C in 30m). Immediate transfer of vulnerable vaccines to ${targetFridgeName} is required.`
  };
}

/**
 * Generate AI Compressor Health Diagnostic using Groq
 */
async function generateCompressorDiagnostic({ fridgeName, healthScore, coolingRate, status }) {
  if (!GROQ_API_KEY) {
    return `Compressor health is ${healthScore}/100. Status: ${status}. Cooling rate: ${coolingRate}°C/min.`;
  }

  const prompt = `
You are an IoT Refrigeration and HVAC Reliability Engineer evaluating a vaccine storage compressor.
Telemetry Assessment:
- Unit: ${fridgeName}
- Compressor Health Score: ${healthScore} / 100
- Measured Pull-Down Rate: ${coolingRate} °C/min (Nominal baseline: -0.15 °C/min)
- Current Diagnostic Status: ${status}

Provide a 2-sentence engineering diagnostic highlighting whether this indicates mechanical valve fatigue, refrigerant gas leakage, or normal thermodynamic hysteresis, and specify the maintenance urgency.
`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: 'You are an expert IoT refrigeration hardware engineer.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 150
      })
    });

    const data = await res.json();
    if (data.choices && data.choices[0]?.message?.content) {
      return data.choices[0].message.content.trim();
    }
  } catch (err) {
    console.error('[Groq AI Diagnostic] Error:', err.message);
  }

  return `Compressor operating at ${healthScore}/100 efficiency (${coolingRate}°C/min).`;
}

module.exports = {
  generateClinicalBrief,
  generateCompressorDiagnostic
};

