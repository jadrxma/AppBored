const WebSocket = require('ws');

const AIS_KEY = '210e80f698fcb84784ff542be8728a33dcd36c06';

// AOR bounding box: Middle East
const AOR = { lamin: -5, lomin: 30, lamax: 42, lomax: 65 };

exports.handler = async function(event, context) {
  // This function connects to AISStream server-side and returns
  // a batch snapshot of vessels as JSON (polled every 60s by client)
  
  return new Promise((resolve) => {
    const vessels = {};
    let resolved = false;
    
    const done = () => {
      if (resolved) return;
      resolved = true;
      
      const vesselArray = Object.values(vessels);
      resolve({
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        },
        body: JSON.stringify({
          vessels: vesselArray,
          timestamp: new Date().toISOString(),
          count: vesselArray.length
        })
      });
    };

    // Timeout after 8 seconds (Netlify functions have 10s limit on free tier)
    const timeout = setTimeout(done, 8000);

    let ws;
    try {
      ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    } catch(e) {
      clearTimeout(timeout);
      resolve({
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'WebSocket creation failed: ' + e.message })
      });
      return;
    }

    ws.on('open', () => {
      const sub = {
        APIKey: AIS_KEY,
        BoundingBoxes: [[[AOR.lamin, AOR.lomin], [AOR.lamax, AOR.lomax]]],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData']
      };
      ws.send(JSON.stringify(sub));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.error) {
          clearTimeout(timeout);
          ws.close();
          resolve({
            statusCode: 401,
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ error: msg.error })
          });
          return;
        }

        const type = msg.MessageType;
        const meta = msg.MetaData || {};
        const mmsi = String(meta.MMSI || meta.MMSI_String || '');
        if (!mmsi) return;

        const lat = parseFloat(meta.latitude || meta.Latitude || 0);
        const lng = parseFloat(meta.longitude || meta.Longitude || 0);
        if (!lat || !lng) return;

        if (type === 'PositionReport') {
          const pos = msg.Message?.PositionReport || {};
          const hdg = (pos.TrueHeading && pos.TrueHeading !== 511)
            ? pos.TrueHeading : (pos.Cog || 0);
          const speed = pos.Sog != null ? parseFloat(pos.Sog.toFixed(1)) : 0;

          if (!vessels[mmsi]) {
            vessels[mmsi] = {
              name: (meta.ShipName || '').trim() || mmsi,
              type: 'Unknown',
              flag: mmsiToFlag(mmsi),
              mmsi, lat, lng,
              heading: hdg,
              speed,
              destination: '',
              imo: '',
              callsign: ''
            };
          } else {
            Object.assign(vessels[mmsi], { lat, lng, heading: hdg, speed });
          }
        }

        if (type === 'ShipStaticData') {
          const sd = msg.Message?.ShipStaticData || {};
          const name = (sd.Name || meta.ShipName || '').trim();
          const category = aisTypeToCategory(sd.Type || 0);
          if (vessels[mmsi]) {
            if (name && name !== mmsi) vessels[mmsi].name = name;
            if (category !== 'Unknown') vessels[mmsi].type = category;
            vessels[mmsi].destination = (sd.Destination || '').trim();
            vessels[mmsi].callsign = (sd.CallSign || '').trim();
            vessels[mmsi].imo = String(sd.ImoNumber || '').replace(/^0+/, '');
            if (sd.Dimension) {
              vessels[mmsi].length = (sd.Dimension.A || 0) + (sd.Dimension.B || 0);
            }
          }
        }

        // Once we have enough vessels, return early
        if (Object.keys(vessels).length >= 300) {
          clearTimeout(timeout);
          ws.close();
          done();
        }
      } catch(e) {
        // ignore parse errors
      }
    });

    ws.on('error', (e) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolve({
          statusCode: 502,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: 'AISStream connection failed: ' + e.message })
        });
        resolved = true;
      }
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      done();
    });
  });
};

function aisTypeToCategory(typeCode) {
  if (typeCode === 35) return 'Military';
  if (typeCode >= 80 && typeCode <= 89) return 'Tanker';
  if (typeCode >= 70 && typeCode <= 79) return 'Cargo';
  if (typeCode >= 60 && typeCode <= 69) return 'Passenger Ferry';
  if (typeCode === 30) return 'Fishing';
  if (typeCode === 52) return 'Tug';
  if (typeCode === 36 || typeCode === 37) return 'Small Craft';
  if (typeCode >= 40 && typeCode <= 49) return 'High Speed Craft';
  if (typeCode === 31 || typeCode === 32) return 'Towing';
  return 'Unknown';
}

function mmsiToFlag(mmsi) {
  const m = String(mmsi).padStart(9, '0');
  const mid = parseInt(m.substring(0, 3));
  const midMap = {
    338:'USA', 303:'USA', 366:'USA', 367:'USA', 368:'USA', 369:'USA',
    232:'GBR', 233:'GBR', 234:'GBR', 235:'GBR',
    228:'FRA', 227:'FRA',
    244:'NLD', 245:'NLD', 246:'NLD',
    211:'DEU', 218:'DEU',
    247:'ITA', 248:'MLT', 249:'MLT',
    224:'ESP', 225:'ESP',
    257:'NOR', 258:'NOR', 259:'NOR',
    219:'DNK', 220:'DNK',
    265:'SWE', 266:'SWE',
    422:'IRN', 423:'IRN',
    447:'KWT', 466:'QAT', 470:'UAE', 408:'BHR',
    403:'SAU', 461:'OMN', 431:'JPN', 440:'KOR',
    416:'TWN', 563:'SGP',
    477:'HKG', 413:'CHN', 412:'CHN',
    503:'AUS', 316:'CAN',
    636:'LBR', 538:'MHL', 370:'PAN', 352:'PAN',
    372:'PAN', 353:'PAN', 374:'PAN',
    419:'IND', 304:'ATG',
    310:'BMU', 309:'BHS',
    205:'BEL', 209:'CYP', 241:'GRC', 240:'GRC',
    622:'EGY', 621:'DJI', 634:'KEN',
    710:'BRA', 667:'GIN',
  };
  return midMap[mid] || '---';
}
