/* Aircraft identification from an ICAO type code. */
import spriteMap from '../../images/aircraft/sprite-map.json' with { type: 'json' };

const TYPES = {
  A321: { name: 'Airbus A321', maker: 'Airbus' },
  A346: { name: 'Airbus A340-600', maker: 'Airbus' },
  A359: { name: 'Airbus A350-900', maker: 'Airbus' },
  A35K: { name: 'Airbus A350-1000', maker: 'Airbus' },
  A388: { name: 'Airbus A380-800', maker: 'Airbus' },
  A333: { name: 'Airbus A330-300', maker: 'Airbus' }, A306: { name: 'Airbus A300-600', maker: 'Airbus' },
  A310: { name: 'Airbus A310', maker: 'Airbus' }, A318: { name: 'Airbus A318', maker: 'Airbus' },
  A319: { name: 'Airbus A319', maker: 'Airbus' }, A320: { name: 'Airbus A320', maker: 'Airbus' },
  A332: { name: 'Airbus A330-200', maker: 'Airbus' }, A339: { name: 'Airbus A330-900', maker: 'Airbus' },
  A346: { name: 'Airbus A340-600', maker: 'Airbus' }, A359: { name: 'Airbus A350-900', maker: 'Airbus' },
  A35K: { name: 'Airbus A350-1000', maker: 'Airbus' },  B712: { name: 'Boeing 717-200', maker: 'Boeing' }, B733: { name: 'Boeing 737-300', maker: 'Boeing' },
  B734: { name: 'Boeing 737-400', maker: 'Boeing' }, B735: { name: 'Boeing 737-500', maker: 'Boeing' },
  B736: { name: 'Boeing 737-600', maker: 'Boeing' }, B737: { name: 'Boeing 737-700', maker: 'Boeing' },
  B738: { name: 'Boeing 737-800', maker: 'Boeing' }, B739: { name: 'Boeing 737-900', maker: 'Boeing' },
  B744: { name: 'Boeing 747-400', maker: 'Boeing' }, B748: { name: 'Boeing 747-8', maker: 'Boeing' },
  B752: { name: 'Boeing 757-200', maker: 'Boeing' }, B753: { name: 'Boeing 757-300', maker: 'Boeing' },
  B762: { name: 'Boeing 767-200', maker: 'Boeing' }, B763: { name: 'Boeing 767-300', maker: 'Boeing' },
  B764: { name: 'Boeing 767-400', maker: 'Boeing' }, B772: { name: 'Boeing 777-200', maker: 'Boeing' },
  B77W: { name: 'Boeing 777-300ER', maker: 'Boeing' }, B788: { name: 'Boeing 787-8', maker: 'Boeing' },
  B789: { name: 'Boeing 787-9', maker: 'Boeing' }, B78X: { name: 'Boeing 787-10', maker: 'Boeing' },
  E190: { name: 'Embraer E190', maker: 'Embraer' }, E195: { name: 'Embraer E195', maker: 'Embraer' },
  AT72: { name: 'ATR 72', maker: 'ATR' }, DH8D: { name: 'Dash 8 Q400', maker: 'De Havilland' },
  C208: { name: 'Cessna 208 Caravan', maker: 'Cessna' }, PA28: { name: 'Piper PA-28', maker: 'Piper' },
  BE58: { name: 'Beechcraft Baron 58', maker: 'Beechcraft' }, R44: { name: 'Robinson R44', maker: 'Robinson' },
  EC35: { name: 'Airbus H135', maker: 'Airbus Helicopters' }, C172: { name: 'Cessna 172', maker: 'Cessna' },
};

/** Existing Commons fallback images for types not included in the provided atlas. */
export const IMAGES = {
  a380: 'images/aircraft/a380.svg', b747: 'images/aircraft/b747.svg', b757: 'images/aircraft/b757.svg',
  b737: 'images/aircraft/b737.svg', b777: 'images/aircraft/b777.svg', b787: 'images/aircraft/b787.svg',
  'b787-9': 'images/aircraft/b787-9.svg', 'generic-narrowbody': 'images/aircraft/generic-narrowbody.svg',
  'generic-widebody': 'images/aircraft/generic-widebody.svg', 'generic-light': 'images/aircraft/generic-light.svg',
  generic: 'images/aircraft/generic.svg',
};

const FALLBACK = {
  A388: 'a380', B744: 'b747', B748: 'b747', B752: 'b757', B753: 'b757',
  B772: 'b777', B77W: 'b777', B788: 'b787', B789: 'b787-9', B78X: 'b787-9',
};

/** Normalize a type code: uppercase, letters and digits only. */
export function normaliseType(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Return sprite sheet geometry for an ICAO type, or null if the atlas has no match. */
/* Types the atlas has no frame for, drawn with the frame whose top-view shape is
   the same layout: engines, wing and tail. A type with no true match is left out. */
const SPRITE_ALIASES = {
  // Boeing / Airbus families
  B737: 'B738', B733: 'B738', B734: 'B738', B735: 'B738', B736: 'B738', B739: 'B738',
  B37M: 'B38M', B39M: 'B38M', B3XM: 'B38M',
  B77L: 'B772', B773: 'B77W', B778: 'B77W', B779: 'B77W',
  B788: 'B789', B78X: 'B789',
  B762: 'A310', B763: 'A310', B764: 'A310',
  B741: 'A346', B742: 'A346', B743: 'A346', B744: 'A346', B748: 'A346', B703: 'A343',
  BCS1: 'E290', BCS3: 'E290',
  // Rear-engine, T-tail jets
  B712: 'F100', B722: 'F100', MD81: 'F100', MD82: 'F100', MD83: 'F100', MD87: 'F100', MD88: 'F100', MD90: 'F100', T154: 'F100',
  CRJ1: 'F70', CRJ2: 'F70', CRJ7: 'F70', CRJ9: 'F70', CRJX: 'F70', E135: 'F70', E145: 'F70', E45X: 'F70',
  E170: 'E190', E75L: 'E190', E75S: 'E190', E195: 'E190', E290: 'E290', E295: 'E290', SU95: 'E190',
  // Business jets
  GLF4: 'GLEX', GLF5: 'GLEX', GLF6: 'GLEX', GL5T: 'GLEX', GL7T: 'GLEX', CL60: 'GLEX', CL35: 'GLEX', C700: 'GLEX', C750: 'GLEX', FA7X: 'GLEX', FA8X: 'GLEX', F900: 'GLEX', LEG2: 'GLEX',
  H25B: 'H25A', FA50: 'H25A', FA20: 'H25A', LJ35: 'H25A', LJ45: 'H25A', LJ75: 'H25A', E55P: 'H25A', E50P: 'H25A',
  C25A: 'C560', C25B: 'C560', C25C: 'C560', C510: 'C560', C525: 'C560', C56X: 'C560', C680: 'C560', C68A: 'C560',
  // Turboprops and military transports
  AT72: 'AT75', AT76: 'AT75', AT45: 'AT75', AT43: 'AT75',
  C130: 'A400', C30J: 'A400', C17: 'A400', IL76: 'A400',
  TBM7: 'PC12', TBM8: 'PC12', TBM9: 'PC12', KODI: 'C208',
  // Light aircraft and helicopters
  DA62: 'DA42', DA40: 'SR22', PA24: 'P28A', PA28: 'P28A', P28B: 'P28A', P28R: 'P28A', PA34: 'PA44', BE55: 'PA44', BE58: 'PA44', PA18: 'C172', C152: 'C172',
  H60: 'B412', S76: 'A139', EC35: 'EC45', H145: 'EC45', H135: 'EC45',
};

export function aircraftSprite(value) {
  const raw = normaliseType(value);
  const type = spriteMap.airframeToSprite[raw] ? raw : (SPRITE_ALIASES[raw] || raw);
  const spriteName = spriteMap.airframeToSprite[type];
  if (!spriteName) return null;
  const sprite = spriteMap.sprites[spriteName];
  if (!sprite) return null;
  return { name: spriteName, ...sprite, width: 72, height: 72, sheet: 'images/aircraft/spritesheet.png' };
}

/**
 * Identify the aircraft from the first source that has a type.
 * The sprite atlas is preferred; a distinct Commons image is used where available.
 */
export function identifyAircraft({ simulator, simbrief, profile } = {}) {
  const candidates = [
    { source: 'simulator', value: simulator },
    { source: 'simbrief', value: simbrief },
    { source: 'profile', value: profile },
  ];
  for (const { source, value } of candidates) {
    const type = normaliseType(value);
    if (!type) continue;
    const known = TYPES[type];
    if (!known) return { type, source, name: type, maker: null, image: IMAGES.generic, sprite: null, known: false };
    const sprite = aircraftSprite(type);
    return {
      type, source, name: known.name, maker: known.maker,
      image: sprite && !FALLBACK[type] ? null : (IMAGES[FALLBACK[type]] || IMAGES.generic),
      sprite, known: true,
    };
  }
  return { type: null, source: null, name: null, maker: null, image: null, sprite: null, known: false };
}
