import zlib from 'node:zlib';

function decodeCMap(source) {
  const mapping = new Map();
  for (const block of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const match of block[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>/gi)) {
      mapping.set(match[1].toUpperCase(), String.fromCodePoint(parseInt(match[2], 16)));
    }
  }
  for (const block of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const entries = /<([\da-f]+)>\s*<([\da-f]+)>\s*(?:<([\da-f]+)>|\[([\s\S]*?)\])/gi;
    for (const match of block[1].matchAll(entries)) {
      const start = parseInt(match[1], 16);
      const end = parseInt(match[2], 16);
      if (match[4]) {
        const values = [...match[4].matchAll(/<([\da-f]+)>/gi)];
        values.forEach((value, offset) => {
          mapping.set((start + offset).toString(16).padStart(match[1].length, '0').toUpperCase(), String.fromCodePoint(parseInt(value[1], 16)));
        });
      } else {
        const target = parseInt(match[3], 16);
        for (let code = start; code <= Math.min(end, start + 2048); code++) {
          mapping.set(code.toString(16).padStart(match[1].length, '0').toUpperCase(), String.fromCodePoint(target + code - start));
        }
      }
    }
  }
  return mapping;
}

function pdfObjects(buffer) {
  const source = buffer.toString('latin1');
  const objects = new Map();
  const pattern = /(\d+)\s+\d+\s+obj\b([\s\S]*?)\bendobj/g;
  for (const match of source.matchAll(pattern)) {
    objects.set(Number(match[1]), { body: match[2], stream: null });
  }
  return objects;
}

function streamBytes(object) {
  if (!object || object.stream !== null) return object?.stream;
  const marker = /\bstream\r?\n/.exec(object.body);
  if (!marker) return null;
  const start = marker.index + marker[0].length;
  const end = object.body.indexOf('endstream', start);
  if (end < 0) return null;
  let encoded = Buffer.from(object.body.slice(start, end).replace(/\r?\n$/, ''), 'latin1');
  if (/\/FlateDecode\b/.test(object.body.slice(0, marker.index))) {
    try {
      encoded = zlib.inflateSync(encoded);
    } catch {
      try { encoded = zlib.inflateRawSync(encoded); } catch { return null; }
    }
  }
  object.stream = encoded;
  return encoded;
}

function referencedIds(value) {
  return [...value.matchAll(/(\d+)\s+\d+\s+R/g)].map((match) => Number(match[1]));
}

function pdfStringText(block, fontMaps) {
  const fontKey = /\/(F\d+)\s+[-\d.]+\s+Tf/.exec(block)?.[1];
  const mapping = fontMaps.get(fontKey) || new Map();
  let text = '';
  for (const match of block.matchAll(/<([\da-f]+)>/gi)) {
    const value = match[1].toUpperCase();
    const unitLength = mapping.size ? [...mapping.keys()].reduce((max, code) => Math.max(max, code.length), 0) : 4;
    for (let index = 0; index + unitLength <= value.length; index += unitLength) {
      const glyph = value.slice(index, index + unitLength);
      text += mapping.get(glyph) ?? '';
    }
  }
  return text;
}

/** Extract visible text emitted by the app's PDF generator for compliance labels. */
export function extractPdfText(buffer) {
  try {
    const objects = pdfObjects(buffer);
    const cmapById = new Map();
    const cmapIds = new Set();
    for (const object of objects.values()) {
      const cmapReference = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(object.body);
      if (cmapReference) cmapIds.add(Number(cmapReference[1]));
    }
    for (const id of cmapIds) {
      const object = objects.get(id);
      const bytes = streamBytes(object);
      if (bytes) cmapById.set(id, decodeCMap(bytes.toString('latin1')));
    }

    let pages = [...objects.values()].filter((object) => /\/Type\s*\/Page\b/.test(object.body));
    if (!pages.length) pages = [...objects.values()];
    const texts = [];

    for (const page of pages) {
      let resources = page.body;
      const resourceRef = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(page.body);
      if (resourceRef) resources = objects.get(Number(resourceRef[1]))?.body ?? page.body;
      const fontReferences = [...resources.matchAll(/\/(F\d+)\s+(\d+)\s+\d+\s+R/g)];
      const fontMaps = new Map();
      for (const fontReference of fontReferences) {
        const fontObject = objects.get(Number(fontReference[2]));
        const cmapRef = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(fontObject?.body ?? '');
        if (cmapRef) fontMaps.set(fontReference[1], cmapById.get(Number(cmapRef[1])) ?? new Map());
      }

      let contentReferences = [];
      const contents = /\/Contents\s*(\[[\s\S]*?\]|\d+\s+\d+\s+R)/.exec(page.body)?.[1];
      if (contents) contentReferences = referencedIds(contents);
      if (!contentReferences.length) {
        contentReferences = [...objects.entries()]
          .filter(([, object]) => /\bstream\r?\n/.test(object.body) && !/\/Subtype\s*\/Image/.test(object.body))
          .map(([id]) => id);
      }

      for (const contentId of contentReferences) {
        const bytes = streamBytes(objects.get(contentId));
        if (!bytes) continue;
        const content = bytes.toString('latin1');
        for (const textBlock of content.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)) {
          texts.push(pdfStringText(textBlock[1], fontMaps));
        }
      }
    }
    return texts.join(' ');
  } catch {
    return '';
  }
}

export function conformityFromPdfText(text) {
  const normalized = String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const headerStatus = /\bNON\s+CONFORME\b|\bCONFORME\b/.exec(normalized.slice(0, 900))?.[0];
  if (headerStatus) return headerStatus.startsWith('NON') ? 'Non conforme' : 'Conforme';
  if (/NON\s*CONFORME/.test(normalized)) return 'Non conforme';
  if (/\bCONFORME\b/.test(normalized)) return 'Conforme';
  return 'À vérifier';
}

/** Read the compact answer index embedded by recent RubberWay questionnaire PDFs. */
export function answersFromPdfText(text) {
  const marker = /RWANSWERSv1:([A-Za-z0-9+/=\s]+?):ENDRWANSWERS/.exec(String(text));
  if (marker) {
    try {
      const decoded = Buffer.from(marker[1].replace(/\s/g, ''), 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      if (Array.isArray(parsed)) return parsed.filter((item) =>
        item && typeof item.ref === 'string' && typeof item.question === 'string' &&
        typeof item.response === 'string' && item.response.trim(),
      );
    } catch { /* Les anciens PDF utilisent le tableau imprimé. */ }
  }

  return legacyAnswersFromPdfText(String(text));
}

function legacyAnswersFromPdfText(text) {
  const questionHeader = /(DROITS FONCIERS|ENVIRONNEMENT|DROITS DES TIERS|MÉNAGES|MENAGES|TRAVAILLEURS|REVENU EXPLOITANT)\s+(\d{1,2})\s+/giu;
  const matches = [...text.matchAll(questionHeader)];
  const knownReferences = new Set(matches.map((match) => match[2]));
  const results = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    const segment = text.slice(start, end)
      .split(/\b(?:Th[eè]me\s+Ref\s+Question|FIN\s+PHOTOS)\b/i)[0]
      .replace(/\s+(?:DROITS FONCIERS|ENVIRONNEMENT|DROITS DES TIERS|MÉNAGES|MENAGES|TRAVAILLEURS|REVENU EXPLOITANT)(?:\s*\|\s*REVENU EXPLOITANT)?\s*$/iu, '')
      .replace(/\s+/g, ' ').trim();
    if (!segment) continue;

    const optionPattern = /\b([A-Z])\s+X\s+([\s\S]*?)(?=\s+[A-Z]\s+(?:X\s+)?|$)/g;
    const selectedResponses = [];
    for (const selected of segment.matchAll(optionPattern)) {
      const response = selected[2]
        .replace(/\s+\d+(?:\/\d+)*\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (response && !/^\d+$/.test(response)) selectedResponses.push(response);
    }

    if (selectedResponses.length) {
      const firstOption = /\s[A-Z]\s+(?:X\s+)?/.exec(segment);
      const question = (firstOption ? segment.slice(0, firstOption.index) : segment)
        .replace(/\s+/g, ' ').trim();
      for (const response of selectedResponses) {
        results.push({ ref: match[2], theme: match[1], question, response });
      }
      continue;
    }

    const freeResponse = /\b0\s+\(([^)]*)\)\s+([\s\S]*)$/.exec(segment);
    if (freeResponse && !/photo|image|fichier/i.test(freeResponse[1])) {
      let response = freeResponse[2].replace(/\s+/g, ' ').trim();
      const lastToken = /(\d+)\s*$/.exec(response)?.[1];
      if (lastToken && knownReferences.has(lastToken)) response = response.slice(0, -lastToken.length).trim();
      if (response && !response.startsWith('(')) {
        const question = segment.slice(0, freeResponse.index).replace(/\s+/g, ' ').trim();
        results.push({ ref: match[2], theme: match[1], question, response });
      }
    }
  }
  return results;
}
