type RenderRequest = {
  id: number
  values: (number | null)[][]
  latitudes: number[]
  longitudes: number[]
  domain: [number, number]
  palette: string[]
  logarithmic: boolean
}

const rgbCache = new Map<string, [number, number, number]>()
let maskPromise: Promise<{ pixels: Uint8ClampedArray; width: number; height: number }> | null = null

function hexToRgb(hex: string): [number, number, number] {
  const cached = rgbCache.get(hex)
  if (cached) return cached
  const value = Number.parseInt(hex.slice(1), 16)
  const rgb: [number, number, number] = [(value >> 16) & 255, (value >> 8) & 255, value & 255]
  rgbCache.set(hex, rgb)
  return rgb
}

function paintColor(
  pixels: Uint8ClampedArray,
  offset: number,
  value: number,
  domain: [number, number],
  colors: [number, number, number][],
  logarithmic: boolean,
) {
  const normalize = logarithmic
    ? (Math.log10(Math.max(value, domain[0])) - Math.log10(domain[0])) /
      (Math.log10(domain[1]) - Math.log10(domain[0]))
    : (value - domain[0]) / (domain[1] - domain[0])
  const position = Math.max(0, Math.min(1, normalize)) * (colors.length - 1)
  const lower = Math.floor(position)
  const upper = Math.min(colors.length - 1, lower + 1)
  const mix = position - lower
  const a = colors[lower]
  const b = colors[upper]
  pixels[offset] = Math.round(a[0] + (b[0] - a[0]) * mix)
  pixels[offset + 1] = Math.round(a[1] + (b[1] - a[1]) * mix)
  pixels[offset + 2] = Math.round(a[2] + (b[2] - a[2]) * mix)
  pixels[offset + 3] = 255
}

function loadMask() {
  if (!maskPromise) {
    maskPromise = fetch('/indian-ocean-land-mask.png')
      .then((response) => response.blob())
      .then(createImageBitmap)
      .then((bitmap) => {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const context = canvas.getContext('2d', { willReadFrequently: true })!
        context.drawImage(bitmap, 0, 0)
        return { pixels: context.getImageData(0, 0, bitmap.width, bitmap.height).data, width: bitmap.width, height: bitmap.height }
      })
  }
  return maskPromise
}

self.onmessage = async (event: MessageEvent<RenderRequest>) => {
  const { id, values, latitudes, longitudes, domain, palette, logarithmic } = event.data
  try {
    const mask = await loadMask()
    const sourceHeight = values.length
    const sourceWidth = values[0]?.length ?? 0
    const latitudeStep = sourceHeight > 1 ? Math.abs(latitudes[1] - latitudes[0]) : 0
    const longitudeStep = sourceWidth > 1 ? Math.abs(longitudes[1] - longitudes[0]) : 0
    const southEdge = Math.max(-85, latitudes[0] - latitudeStep / 2)
    const northEdge = Math.min(85, latitudes[sourceHeight - 1] + latitudeStep / 2)
    const westEdge = longitudes[0] - longitudeStep / 2
    const eastEdge = longitudes[sourceWidth - 1] + longitudeStep / 2
    const renderWidth = Math.min(1536, Math.max(768, sourceWidth * 4))
    const mercatorY = (latitude: number) => {
      const radians = latitude * Math.PI / 180
      return .5 - Math.log((1 + Math.sin(radians)) / (1 - Math.sin(radians))) / (4 * Math.PI)
    }
    const latitudeAtMercatorY = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI
    const topY = mercatorY(northEdge)
    const bottomY = mercatorY(southEdge)
    const projectedAspect = (bottomY - topY) / ((eastEdge - westEdge) / 360)
    const renderHeight = Math.max(640, Math.min(4096, Math.round(renderWidth * projectedAspect)))
    const canvas = new OffscreenCanvas(renderWidth, renderHeight)
    const context = canvas.getContext('2d')!
    const image = context.createImageData(renderWidth, renderHeight)
    const colors = palette.map(hexToRgb)
    const maskTop = mercatorY(30)
    const maskBottom = mercatorY(-60)
    const xCoordinates = Array.from({ length: renderWidth }, (_, targetX) => {
      const longitude = westEdge + ((targetX + .5) / renderWidth) * (eastEdge - westEdge)
      const sourceX = sourceWidth > 1
        ? Math.max(0, Math.min(sourceWidth - 1, (longitude - longitudes[0]) / (longitudes[sourceWidth - 1] - longitudes[0]) * (sourceWidth - 1)))
        : 0
      return {
        longitude,
        sourceX,
        x0: Math.floor(sourceX),
        x1: Math.min(sourceWidth - 1, Math.floor(sourceX) + 1),
        xMix: sourceX - Math.floor(sourceX),
        maskX: Math.max(0, Math.min(mask.width - 1, Math.round((longitude - 20) / 100 * (mask.width - 1)))),
      }
    })

    for (let targetY = 0; targetY < renderHeight; targetY += 1) {
      const projectedY = topY + ((targetY + .5) / renderHeight) * (bottomY - topY)
      const latitude = latitudeAtMercatorY(projectedY)
      const sourceY = sourceHeight > 1
        ? Math.max(0, Math.min(sourceHeight - 1, (latitude - latitudes[0]) / (latitudes[sourceHeight - 1] - latitudes[0]) * (sourceHeight - 1)))
        : 0
      const y0 = Math.floor(sourceY)
      const y1 = Math.min(sourceHeight - 1, y0 + 1)
      const yMix = sourceY - y0
      const row0 = values[y0]
      const row1 = values[y1]
      const maskY = Math.max(0, Math.min(mask.height - 1, Math.round((mercatorY(latitude) - maskTop) / (maskBottom - maskTop) * (mask.height - 1))))
      const latitudeInsideMask = latitude >= -60 && latitude <= 30
      for (let targetX = 0; targetX < renderWidth; targetX += 1) {
        const offset = (targetY * renderWidth + targetX) * 4
        const { longitude, sourceX, x0, x1, xMix, maskX } = xCoordinates[targetX]
        if (latitudeInsideMask && longitude >= 20 && longitude <= 120 && mask.pixels[(maskY * mask.width + maskX) * 4 + 3] > 127) {
          image.data[offset + 3] = 0
          continue
        }
        const topWeight = 1 - yMix
        let weighted = 0
        let weight = 0
        const weight00 = topWeight * (1 - xMix)
        const weight01 = topWeight * xMix
        const weight10 = yMix * (1 - xMix)
        const weight11 = yMix * xMix
        const value00 = row0[x0]
        const value01 = row0[x1]
        const value10 = row1[x0]
        const value11 = row1[x1]
        if (value00 !== null) { weighted += value00 * weight00; weight += weight00 }
        if (value01 !== null) { weighted += value01 * weight01; weight += weight01 }
        if (value10 !== null) { weighted += value10 * weight10; weight += weight10 }
        if (value11 !== null) { weighted += value11 * weight11; weight += weight11 }
        let value = weight > 0 ? weighted / weight : null
        if (value === null) {
          const centerY = Math.round(sourceY)
          const centerX = Math.round(sourceX)
          search: for (let radius = 1; radius <= 8; radius += 1) {
            for (let dy = -radius; dy <= radius; dy += 1) {
              for (let dx = -radius; dx <= radius; dx += 1) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
                const nearby = values[centerY + dy]?.[centerX + dx]
                if (nearby !== null && nearby !== undefined) { value = nearby; break search }
              }
            }
          }
        }
        if (value !== null) paintColor(image.data, offset, value, domain, colors, logarithmic)
      }
    }
    context.putImageData(image, 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    self.postMessage({ id, blob })
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
}
