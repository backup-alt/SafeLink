import assert from 'node:assert/strict'
// Run after pnpm run build, with the fixture server on :8013 and an isolated
// headless Chromium session using --remote-debugging-port=9235. Requires Node 22+.
// Fixture server: python -c "from backend.app import app,pfz_service; from backend.tests.test_pfz_nearest import collection; import uvicorn; pfz_service._fetch=lambda:collection([[[80,10],[82,10]]]); uvicorn.run(app,host='127.0.0.1',port=8013,lifespan='off')"
// All device locations/permissions below are simulated; closes the test browser.
const tabs = await (await fetch('http://127.0.0.1:9235/json')).json()
const ws = new WebSocket(tabs[0].webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map(), requests = [], errors = []
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id) }
  if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url)
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails)
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const next = ++id; pending.set(next, m => m.error ? reject(m.error) : resolve(m.result))
  ws.send(JSON.stringify({ id: next, method, params }))
})
const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value
const sleep = ms => new Promise(r => setTimeout(r, ms))
const wait = async expression => {
  for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(200) }
  throw Error('Timeout: ' + expression)
}
const button = async text => evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)})?.click()`)
const nearestCount = () => requests.filter(u=>u.includes('/api/pfz/nearest')).length
await send('Runtime.enable'); await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: 'http://127.0.0.1:8013/' })
await wait("document.body.innerText.includes('PFZ features')")
await button('Find nearest PFZ')
await wait("!!document.querySelector('.location-picker')")
assert.equal(nearestCount(), 0)
await send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'denied', origin: 'http://127.0.0.1:8013' })
await button('Use my current location')
await wait("document.body.innerText.includes('Location access is blocked')")
assert.equal(nearestCount(), 0)
console.log('Permission denied: actionable error, no PFZ lookup')
await button('Choose on map')
await send('Input.dispatchMouseEvent', {type:'mousePressed',x:720,y:400,button:'left',clickCount:1})
await send('Input.dispatchMouseEvent', {type:'mouseReleased',x:720,y:400,button:'left',clickCount:1})
await wait("document.body.innerText.includes('Selected starting location')")
assert.equal(nearestCount(), 0)
assert.equal(await evaluate("document.querySelector('.origin-location-marker span')?.textContent"), 'Starting location')
await button('Find PFZ from this location')
await wait("!!document.querySelector('.nearest-pfz-card')")
assert.equal(nearestCount(), 1)
console.log('Map selection: marked and confirmed before lookup')
await button('Find nearest PFZ')
await send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'granted', origin: 'http://127.0.0.1:8013' })
await send('Emulation.setGeolocationOverride', {latitude:11,longitude:81,accuracy:1500})
await button('Use my current location')
await wait("document.body.innerText.includes('Device-reported location')")
assert.equal(nearestCount(), 1)
assert.ok(await evaluate("document.body.innerText.includes('coarse location')"))
assert.equal(await evaluate("document.querySelector('.origin-location-marker span')?.textContent"), 'Your device location')
await sleep(1200)
await button('Find PFZ from this location')
await wait("!!document.querySelector('.nearest-pfz-card')")
assert.equal(nearestCount(), 2)
assert.ok(requests.filter(u=>u.includes('/api/pfz/nearest')).at(-1).includes('longitude=81&latitude=11'))
console.log('Device location: simulated coordinates, accuracy warning, confirmation and lookup')
await button('Find nearest PFZ')
await evaluate("navigator.geolocation.getCurrentPosition=(ok,fail)=>setTimeout(()=>fail({code:3}),10)")
await button('Use my current location')
await wait("document.body.innerText.includes('timed out')")
console.log('Timeout: manual fallback remains available')
await evaluate("navigator.geolocation.getCurrentPosition=(ok)=>setTimeout(()=>ok({coords:{longitude:82,latitude:12,accuracy:20}}),500)")
await button('Use my current location')
await evaluate("document.querySelector('[aria-label=\"Cancel location selection\"]').click()")
await sleep(800)
assert.equal(await evaluate("!!document.querySelector('.location-picker')"), false)
assert.equal(nearestCount(), 2)
assert.equal(await evaluate("!!document.querySelector('.origin-location-marker')"), false)
assert.deepEqual(errors, [])
console.log('Cancel ignores late location callbacks; no runtime errors')
await send('Browser.close'); ws.close()
