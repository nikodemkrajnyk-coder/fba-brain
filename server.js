require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ═══════════════════════════════════════
// WESTMERE PRIVATE HIRE — SERVER
// Serves frontend + Google Places proxy
// ═══════════════════════════════════════

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// Serve Google Maps API key to frontend (loaded via script)
app.get('/api/maps-key', (req, res) => {
  res.json({ key: GOOGLE_MAPS_KEY });
});

// Google Places Autocomplete proxy (avoids CORS + hides API key)
app.get('/api/places/autocomplete', async (req, res) => {
  const { input } = req.query;
  if (!input || !GOOGLE_MAPS_KEY) return res.json({ predictions: [] });
  try {
    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&components=country:gb&types=geocode|establishment&key=${GOOGLE_MAPS_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.json({ predictions: [] });
  }
});

// Google Place Details proxy (get lat/lng from place_id)
app.get('/api/places/details', async (req, res) => {
  const { place_id } = req.query;
  if (!place_id || !GOOGLE_MAPS_KEY) return res.json({ result: null });
  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(place_id)}&fields=geometry,formatted_address,name,address_components&key=${GOOGLE_MAPS_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.json({ result: null });
  }
});

// Fallback: serve index.html for all unknown routes (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Westmere Private Hire running on port ${PORT}`));
