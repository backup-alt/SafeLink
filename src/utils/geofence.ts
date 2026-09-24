/** lightweight geofence helpers without Turf for hackathon */
export function pointInPolygon(lng: number, lat: number, polygon: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
export function haversineKm(lon1:number, lat1:number, lon2:number, lat2:number): number {
  const R=6371.0088; const dLat=(lat2-lat1)*Math.PI/180, dLon=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.asin(Math.sqrt(a));
}
export function destination(lon:number, lat:number, distKm:number, bearingDeg:number): [number,number]{
  const R=6371.0088, br=bearingDeg*Math.PI/180, d=distKm/R;
  const rLat=lat*Math.PI/180, rLon=lon*Math.PI/180;
  const lat2=Math.asin(Math.sin(rLat)*Math.cos(d)+Math.cos(rLat)*Math.sin(d)*Math.cos(br));
  const lon2=rLon+Math.atan2(Math.sin(br)*Math.sin(d)*Math.cos(rLat), Math.cos(d)-Math.sin(rLat)*Math.sin(lat2));
  return [lon2*180/Math.PI, lat2*180/Math.PI];
}
