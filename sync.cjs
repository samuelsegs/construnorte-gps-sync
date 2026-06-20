/**
 * sync.cjs — Consulta Ovisión y escribe posiciones en Firestore.
 * Se ejecuta una vez por invocación (GitHub Actions maneja el intervalo).
 * Variables de entorno requeridas: OVIS_LOGIN, OVIS_PASSWORD, FIREBASE_SERVICE_ACCOUNT_B64
 */

const http  = require('http')
const admin = require('firebase-admin')

// ── Firebase ──────────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8')
)
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
const db = admin.firestore()

// ── Ovisión ───────────────────────────────────────────────────────────────────
const OVIS_HOST = 'ws.grupouda.com.mx'
const OVIS_PATH = '/wsUDAHistoryGetByPlate.asmx/HistoyDataLastLocationByUser'
const MAX_RETRIES = 3

const MAPPING = {
  'Raul Rendon Ortega':              '88BJ1B',
  'KR0788A  FORTINO DE LOS SANTOS':  'KR0788A',
  'ABRHAM RODRIGUEZ':                '49BK5K',
  '55BL8G   MANUEL PATRICIO PONCE':  '55BL8G',
}

function field(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`))
  return m ? m[1].trim() : ''
}

function resolveId(rawId) {
  const raw = rawId.trim()
  if (!raw) return null
  if (!raw.includes(' ') && /[0-9]/.test(raw)) return raw
  const first = raw.split(/\s+/)[0]
  if (/^[A-Z0-9]{5,10}$/i.test(first) && /[0-9]/.test(first)) return first
  return MAPPING[raw] || null
}

function fetchOvision(login, password) {
  return new Promise((resolve, reject) => {
    const body = `sLogin=${encodeURIComponent(login)}&sPassword=${encodeURIComponent(password)}`
    const req = http.request({
      hostname: OVIS_HOST,
      path: OVIS_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.setTimeout(30000, () => req.destroy(new Error('Timeout Ovisión')))
    req.write(body)
    req.end()
  })
}

async function fetchOvisionWithRetry(login, password) {
  let lastError
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`Reintento ${attempt}/${MAX_RETRIES} conectando a Ovisión...`)
        await new Promise(r => setTimeout(r, attempt * 2000))
      }
      return await fetchOvision(login, password)
    } catch (err) {
      lastError = err
      console.warn(`[WARN] Intento ${attempt} fallido: ${err.message}`)
    }
  }
  throw new Error(`Ovisión no respondió tras ${MAX_RETRIES} intentos: ${lastError.message}`)
}

function parsePositions(xml) {
  const code = (xml.match(/<code>(\d+)<\/code>/) || [])[1]
  if (code !== '100') throw new Error(`Ovisión code ${code}: ${xml.slice(0, 200)}`)

  const updatedAt = new Date().toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })

  const positions = []
  const skipped = []
  const blocks = xml.split(/<Plate id="/)
  blocks.shift()

  for (const block of blocks) {
    const rawId = block.split('"')[0].trim()

    let placa = field(block, 'Plate')
    if (!placa) placa = resolveId(rawId)

    if (!placa) {
      skipped.push({ rawId, reason: 'Sin mapeo de placa' })
      console.warn(`[SKIP] rawId="${rawId}" — sin mapeo de placa`)
      continue
    }
    if (placa.length > 20 || placa.includes('/') || placa.includes(' ')) {
      skipped.push({ rawId, placa, reason: 'Formato de placa inválido' })
      console.warn(`[SKIP] placa="${placa}" — formato inválido`)
      continue
    }

    const lat = parseFloat(field(block, 'Latitude'))
    const lon = parseFloat(field(block, 'Longitude'))

    if (!lat || !lon) {
      skipped.push({ rawId, placa, reason: 'Coordenadas ausentes' })
      console.warn(`[SKIP] placa="${placa}" — lat/lon ausentes`)
      continue
    }
    if (lat < 10 || lat > 35 || lon > -80 || lon < -120) {
      skipped.push({ rawId, placa, reason: `Coordenadas fuera de México (lat=${lat}, lon=${lon})` })
      console.warn(`[SKIP] placa="${placa}" — coords fuera de México: lat=${lat}, lon=${lon}`)
      continue
    }

    const speed    = parseFloat(field(block, 'Speed')) || 0
    const ignState = field(block, 'IgnitionState')
    const ignicion = ignState === '1' ? 'Encendido' : 'Apagado'
    const estado   = speed > 5 ? 'En movimiento' : ignicion === 'Encendido' ? 'Detenido (encendido)' : 'Detenido'
    const fuelRaw  = field(block, 'Fuel') || field(block, 'FuelLevel') || field(block, 'FuelQuantity')

    console.log(`[OK] placa=${placa} | lat=${lat} lon=${lon} | vel=${speed} | ${estado}`)

    positions.push({
      placa, lat, lon, vel: speed, ignicion, estado,
      fuel:        fuelRaw || null,
      location:    field(block, 'Location'),
      heading:     field(block, 'Heading'),
      fleet:       field(block, 'Fleet'),
      gpsFix:      field(block, 'GpsFix') === '1',
      dateTimeGPS: field(block, 'DateTimeGPS'),
      updatedAt,
    })
  }

  return { positions, skipped }
}

async function main() {
  const login    = process.env.OVIS_LOGIN
  const password = process.env.OVIS_PASSWORD
  if (!login || !password) throw new Error('Faltan OVIS_LOGIN / OVIS_PASSWORD')

  console.log('Consultando Ovisión...')
  const xml = await fetchOvisionWithRetry(login, password)

  const { positions, skipped } = parsePositions(xml)
  console.log(`Posiciones válidas: ${positions.length} | Descartadas: ${skipped.length}`)

  if (skipped.length > 0) {
    console.warn('[WARN] Vehículos descartados:')
    skipped.forEach(s => console.warn(`  - ${s.placa || s.rawId}: ${s.reason}`))
  }

  // ── Escribir posiciones actuales ──────────────────────────────────────────
  let batch = db.batch(), ops = 0
  for (const pos of positions) {
    batch.set(db.collection('gpsPositions').doc(pos.placa), pos, { merge: true })
    if (++ops === 490) { await batch.commit(); batch = db.batch(); ops = 0 }
  }
  if (ops > 0) await batch.commit()

  // ── Historial GPS ─────────────────────────────────────────────────────────
  const dateKey = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })
  let hBatch = db.batch(), hOps = 0
  for (const pos of positions) {
    const ref = db.collection('gpsHistory').doc(`${pos.placa}_${dateKey}`)
    hBatch.set(ref, {
      placa: pos.placa,
      date:  dateKey,
      positions: admin.firestore.FieldValue.arrayUnion({
        lat:         pos.lat,
        lon:         pos.lon,
        vel:         pos.vel,
        estado:      pos.estado,
        ignicion:    pos.ignicion,
        heading:     pos.heading     || '',
        dateTimeGPS: pos.dateTimeGPS || '',
        updatedAt:   pos.updatedAt,
      }),
    }, { merge: true })
    if (++hOps === 490) { await hBatch.commit(); hBatch = db.batch(); hOps = 0 }
  }
  if (hOps > 0) await hBatch.commit()

  // ── Log de sincronización con detalles ────────────────────────────────────
  await db.collection('settings').doc('gpsSync').set({
    lastSync:      positions[0]?.updatedAt || '',
    lastCount:     positions.length,
    lastSyncMs:    Date.now(),
    lastSkipped:   skipped.length,
    skippedDetail: skipped,
    lastError:     null,
    status:        'ok',
  }, { merge: true })

  console.log(`Sync OK — ${positions.length} posiciones guardadas. Historial: ${dateKey}.`)
  if (skipped.length > 0) console.warn(`Atención: ${skipped.length} vehículo(s) descartado(s). Revisa el log.`)
  process.exit(0)
}

main().catch(async e => {
  console.error('ERROR CRÍTICO:', e.message)

  // Guardar el error en Firestore para que el monitor lo muestre
  try {
    await db.collection('settings').doc('gpsSync').set({
      lastError:  e.message,
      lastSyncMs: Date.now(),
      status:     'error',
    }, { merge: true })
  } catch (_) { /* si Firestore también falla, al menos tenemos el log de consola */ }

  process.exit(1)
})
