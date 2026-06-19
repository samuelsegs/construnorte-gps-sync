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

function parsePositions(xml) {
  const code = (xml.match(/<code>(\d+)<\/code>/) || [])[1]
  if (code !== '100') throw new Error(`Ovisión code ${code}: ${xml.slice(0, 200)}`)

  const updatedAt = new Date().toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })

  const positions = []
  const blocks = xml.split(/<Plate id="/)
  blocks.shift()

  for (const block of blocks) {
    let placa = field(block, 'Plate')
    if (!placa) {
      const rawId = block.split('"')[0].trim()
      placa = resolveId(rawId)
    }
    if (!placa || placa.length > 20 || placa.includes('/') || placa.includes(' ')) continue

    const lat = parseFloat(field(block, 'Latitude'))
    const lon = parseFloat(field(block, 'Longitude'))
    if (!lat || !lon || lat < 10 || lat > 35 || lon > -80 || lon < -120) continue

    const speed   = parseFloat(field(block, 'Speed')) || 0
    const ignState = field(block, 'IgnitionState')
    const ignicion = ignState === '1' ? 'Encendido' : 'Apagado'
    const estado   = speed > 5 ? 'En movimiento' : ignicion === 'Encendido' ? 'Detenido (encendido)' : 'Detenido'
    const fuelRaw  = field(block, 'Fuel') || field(block, 'FuelLevel') || field(block, 'FuelQuantity')

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
  return positions
}

async function main() {
  const login    = process.env.OVIS_LOGIN
  const password = process.env.OVIS_PASSWORD
  if (!login || !password) throw new Error('Faltan OVIS_LOGIN / OVIS_PASSWORD')

  console.log('Consultando Ovisión...')
  const xml = await fetchOvision(login, password)
  const positions = parsePositions(xml)
  console.log(`Posiciones obtenidas: ${positions.length}`)

  let batch = db.batch(), ops = 0
  for (const pos of positions) {
    batch.set(db.collection('gpsPositions').doc(pos.placa), pos, { merge: true })
    if (++ops === 490) { await batch.commit(); batch = db.batch(); ops = 0 }
  }
  if (ops > 0) await batch.commit()

  await db.collection('settings').doc('gpsSync').set({
    lastSync:   positions[0]?.updatedAt || '',
    lastCount:  positions.length,
    lastSyncMs: Date.now(),
  }, { merge: true })

  // ── Historial GPS: agrega cada posición al documento del día ─────────────
  const dateKey = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })
  let hBatch = db.batch(), hOps = 0
  for (const pos of positions) {
    const ref = db.collection('gpsHistory').doc(`${pos.placa}_${dateKey}`)
    hBatch.set(ref, {
      placa: pos.placa,
      date:  dateKey,
      positions: admin.firestore.FieldValue.arrayUnion({
        lat:        pos.lat,
        lon:        pos.lon,
        vel:        pos.vel,
        estado:     pos.estado,
        ignicion:   pos.ignicion,
        heading:    pos.heading    || '',
        dateTimeGPS: pos.dateTimeGPS || '',
        updatedAt:  pos.updatedAt,
      }),
    }, { merge: true })
    if (++hOps === 490) { await hBatch.commit(); hBatch = db.batch(); hOps = 0 }
  }
  if (hOps > 0) await hBatch.commit()

  console.log(`Sync OK — ${positions.length} posiciones. Historial: ${dateKey}.`)
  process.exit(0)
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1) })
