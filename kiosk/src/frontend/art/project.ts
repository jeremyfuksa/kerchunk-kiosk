// Pure geographic projection for the artistic kiosk: lat/lon -> canvas px,
// anchored on the home QTH. Local equirectangular approximation — accurate at
// metro scale, no tiles, no network. spanM is the radius (meters) that maps
// from center to the nearer canvas edge.
export interface Home {
  lat: number;
  lon: number;
}
export interface Px {
  x: number;
  y: number;
}

export function makeProjection(
  home: Home,
  spanM: number,
  width: number,
  height: number,
): (lat: number, lon: number) => Px {
  const cosLat = Math.cos((home.lat * Math.PI) / 180);
  const half = Math.min(width, height) / 2;
  const pxPerM = half / spanM;
  return (lat: number, lon: number): Px => {
    const dyM = (lat - home.lat) * 111_320; // north positive
    const dxM = (lon - home.lon) * 111_320 * cosLat; // east positive
    return { x: width / 2 + dxM * pxPerM, y: height / 2 - dyM * pxPerM };
  };
}
