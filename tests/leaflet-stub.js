/* Minimal Leaflet stand-in for headless tests when the real library isn't installed.
   It implements only the calls Byway makes and records nothing; map rendering is not tested here.
   Run `npm install` in tests/ to test against real Leaflet 1.9.4 instead. */
(function () {
  const chain = o => Object.assign(o, {
    addTo(g) { if (g && g._items) g._items.add(o); return o; },
    remove() { return o; },
    on() { return o; }, off() { return o; }, once(ev, fn) { if (ev === 'moveend') setTimeout(fn, 0); return o; },
    bindPopup(c) { o._popup = c; return o; }, openPopup() { o._open = true; return o; },
    isPopupOpen() { return !!o._open; }, setPopupContent() { return o; }, closePopup() { o._open = false; return o; },
  });
  const layer = () => chain({});
  const group = () => { const g = chain({ _items: new Set() }); g.clearLayers = () => { g._items.clear(); return g; }; return g; };
  const bounds = pts => ({ pts, isValid: () => true, pad() { return this; } });
  let center = { lat: 39.5, lng: -98.35 }, zoom = 4;
  window.L = {
    version: 'stub',
    map() {
      const m = chain({});
      m.setView = (c, z) => { center = { lat: c[0], lng: c[1] }; zoom = z; return m; };
      m.createPane = () => ({ style: {} });
      m.getCenter = () => center; m.getZoom = () => zoom;
      m.fitBounds = () => m; m.flyTo = (c, z) => { center = { lat: c[0], lng: c[1] }; zoom = z; return m; };
      return m;
    },
    tileLayer: layer, svg: () => ({}), canvas: () => ({}),
    layerGroup: group, polyline: layer, marker: layer, circleMarker: layer,
    divIcon: o => o, latLngBounds: bounds,
  };
})();
