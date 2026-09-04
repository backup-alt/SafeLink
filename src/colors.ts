const rgbCache = new Map<string, [number, number, number]>()

function hexToRgb(hex: string): [number, number, number] {
  const cached = rgbCache.get(hex)
  if (cached) return cached
  const value = Number.parseInt(hex.slice(1), 16)
  const rgb: [number, number, number] = [(value >> 16) & 255, (value >> 8) & 255, value & 255]
  rgbCache.set(hex, rgb)
  return rgb
}

let landMaskPromise: Promise<HTMLImageElement> | null = null
let landMaskContext: CanvasRenderingContext2D | null = null
let landMaskPixels: Uint8ClampedArray | null = null
let landMaskWidth = 0
let landMaskHeight = 0

function loadLandMask(): Promise<HTMLImageElement> {
  if (!landMaskPromise) {
    landMaskPromise = new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        landMaskContext = canvas.getContext('2d', { willReadFrequently: true })
        landMaskContext?.drawImage(image, 0, 0)
        if (landMaskContext) {
          landMaskWidth = canvas.width
          landMaskHeight = canvas.height
          landMaskPixels = landMaskContext.getImageData(0, 0, canvas.width, canvas.height).data
        }
        resolve(image)
      }
      image.onerror = () => reject(new Error('Could not load the coastline mask'))
      image.src = '/indian-ocean-land-mask.png'
    })
  }
  return landMaskPromise
}

export function isLandAt(longitude: number, latitude: number): boolean {
  if (!landMaskPixels || longitude < 20 || longitude > 120 || latitude < -60 || latitude > 30) return false
  const radians = latitude * Math.PI / 180
  const y = .5 - Math.log((1 + Math.sin(radians)) / (1 - Math.sin(radians))) / (4 * Math.PI)
  const northRadians = 30 * Math.PI / 180
  const southRadians = -60 * Math.PI / 180
  const top = .5 - Math.log((1 + Math.sin(northRadians)) / (1 - Math.sin(northRadians))) / (4 * Math.PI)
  const bottom = .5 - Math.log((1 + Math.sin(southRadians)) / (1 - Math.sin(southRadians))) / (4 * Math.PI)
  const xPixel = Math.max(0, Math.min(landMaskWidth - 1, Math.round((longitude - 20) / 100 * (landMaskWidth - 1))))
  const yPixel = Math.max(0, Math.min(landMaskHeight - 1, Math.round((y - top) / (bottom - top) * (landMaskHeight - 1))))
  return landMaskPixels[(yPixel * landMaskWidth + xPixel) * 4 + 3] > 127
}

export function colorAt(
  value: number,
  domain: [number, number],
  palette: string[],
  logarithmic: boolean,
): [number, number, number, number] {
  const normalize = logarithmic
    ? (Math.log10(Math.max(value, domain[0])) - Math.log10(domain[0])) /
      (Math.log10(domain[1]) - Math.log10(domain[0]))
    : (value - domain[0]) / (domain[1] - domain[0])
  const position = Math.max(0, Math.min(1, normalize)) * (palette.length - 1)
  const lower = Math.floor(position)
  const upper = Math.min(palette.length - 1, lower + 1)
  const mix = position - lower
  const a = hexToRgb(palette[lower])
  const b = hexToRgb(palette[upper])
  return [
    Math.round(a[0] + (b[0] - a[0]) * mix),
    Math.round(a[1] + (b[1] - a[1]) * mix),
    Math.round(a[2] + (b[2] - a[2]) * mix),
    255,
  ]
}

export async function fieldToDataUrl(
  values: (number | null)[][],
  latitudes: number[],
  longitudes: number[],
  domain: [number, number],
  palette: string[],
  logarithmic: boolean,
): Promise<string> {
  const sourceHeight = values.length
  const sourceWidth = values[0]?.length ?? 0
  if (!sourceWidth || !sourceHeight) return ''
  const latitudeStep = sourceHeight > 1 ? Math.abs(latitudes[1] - latitudes[0]) : 0
  const longitudeStep = sourceWidth > 1 ? Math.abs(longitudes[1] - longitudes[0]) : 0
  const southEdge = Math.max(-85, latitudes[0] - latitudeStep / 2)
  const northEdge = Math.min(85, latitudes[sourceHeight - 1] + latitudeStep / 2)
  const westEdge = longitudes[0] - longitudeStep / 2
  const eastEdge = longitudes[sourceWidth - 1] + longitudeStep / 2
  // MapLibre performs the final GPU interpolation. Rendering near the source
  // resolution avoids blocking the UI with a multi-million-pixel CPU loop.
  const renderWidth = Math.min(1024, Math.max(640, sourceWidth * 3))
  const canvas = document.createElement('canvas')
  const mercatorY = (latitude: number) => {
    const radians = latitude * Math.PI / 180
    return .5 - Math.log((1 + Math.sin(radians)) / (1 - Math.sin(radians))) / (4 * Math.PI)
  }
  const latitudeAtMercatorY = (y: number) =>
    Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI
  const topY = mercatorY(northEdge)
  const bottomY = mercatorY(southEdge)
  const projectedAspect = (bottomY - topY) / ((eastEdge - westEdge) / 360)
  const renderHeight = Math.max(640, Math.min(4096, Math.round(renderWidth * projectedAspect)))
  canvas.width = renderWidth
  canvas.height = renderHeight
  const context = canvas.getContext('2d')
  if (!context) return ''

  // Load the mask for coordinate hit-testing. The visual field deliberately
  // continues beneath land; the detailed opaque basemap overlay performs the
  // final shoreline cut without magnifying a transparent raster edge.
  await loadLandMask()
  const image = context.createImageData(renderWidth, renderHeight)

  for (let targetY = 0; targetY < renderHeight; targetY += 1) {
    const projectedY = topY + ((targetY + .5) / renderHeight) * (bottomY - topY)
    const latitude = latitudeAtMercatorY(projectedY)
    const sourcePosition = sourceHeight > 1
      ? Math.max(0, Math.min(sourceHeight - 1, (latitude - latitudes[0]) / (latitudes[sourceHeight - 1] - latitudes[0]) * (sourceHeight - 1)))
      : 0
    const lowerRow = Math.floor(sourcePosition)
    const upperRow = Math.min(sourceHeight - 1, lowerRow + 1)
    const rowMix = sourcePosition - lowerRow
    for (let targetX = 0; targetX < renderWidth; targetX += 1) {
      const offset = (targetY * renderWidth + targetX) * 4
      const longitude = westEdge + ((targetX + .5) / renderWidth) * (eastEdge - westEdge)
      if (isLandAt(longitude, latitude)) {
        image.data[offset + 3] = 0
        continue
      }
      const sourcePositionX = sourceWidth > 1
        ? Math.max(0, Math.min(sourceWidth - 1, (longitude - longitudes[0]) / (longitudes[sourceWidth - 1] - longitudes[0]) * (sourceWidth - 1)))
        : 0
      const leftColumn = Math.floor(sourcePositionX)
      const rightColumn = Math.min(sourceWidth - 1, leftColumn + 1)
      const columnMix = sourcePositionX - leftColumn
      const samples = [
        [values[lowerRow][leftColumn], (1 - rowMix) * (1 - columnMix)],
        [values[lowerRow][rightColumn], (1 - rowMix) * columnMix],
        [values[upperRow][leftColumn], rowMix * (1 - columnMix)],
        [values[upperRow][rightColumn], rowMix * columnMix],
      ] as const
      let weightedValue = 0
      let totalWeight = 0
      samples.forEach(([sample, weight]) => {
        if (sample !== null) {
          weightedValue += sample * weight
          totalWeight += weight
        }
      })
      let value = totalWeight > 0 ? weightedValue / totalWeight : null
      // Copernicus grids intentionally contain null land cells. Near a coast,
      // extend the closest valid water value a few source cells so those coarse
      // null blocks cannot become the visible shoreline; the 10 m mask above is
      // the sole authority for the land/water boundary.
      if (value === null) {
        const centerRow = Math.round(sourcePosition)
        const centerColumn = Math.round(sourcePositionX)
        search: for (let radius = 1; radius <= 8; radius += 1) {
          for (let rowOffset = -radius; rowOffset <= radius; rowOffset += 1) {
            for (let columnOffset = -radius; columnOffset <= radius; columnOffset += 1) {
              if (Math.max(Math.abs(rowOffset), Math.abs(columnOffset)) !== radius) continue
              const row = centerRow + rowOffset
              const column = centerColumn + columnOffset
              if (row < 0 || row >= sourceHeight || column < 0 || column >= sourceWidth) continue
              const nearby = values[row][column]
              if (nearby !== null) {
                value = nearby
                break search
              }
            }
          }
        }
      }
      if (value === null) {
        image.data[offset + 3] = 0
        continue
      }
      const color = colorAt(value, domain, palette, logarithmic)
      image.data.set(color, offset)
    }
  }
  context.putImageData(image, 0, 0)
  return canvas.toDataURL('image/png')
}
