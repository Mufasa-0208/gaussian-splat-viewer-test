import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

/**
 * Detects whether an ArrayBuffer contains a PLY file by checking the header.
 */
function isPlyBuffer(buffer) {
  const text = new TextDecoder('ascii').decode(buffer.slice(0, 1024));
  return text.startsWith('ply');
}

/**
 * Parse a PLY file (ASCII or binary_little_endian) into positions and colors.
 * Supports:
 *   - Properties: x, y, z (float/double)
 *   - Optional color: red, green, blue OR r, g, b (0–255)
 */
function parsePly(buffer) {
  const textHeader = new TextDecoder('ascii').decode(buffer.slice(0, 1024 * 64)); // up to 64 KB for header
  const headerEndIndex = textHeader.indexOf('end_header');

  if (headerEndIndex === -1) {
    throw new Error('PLY header does not contain "end_header".');
  }

  const headerText = textHeader.slice(0, headerEndIndex + 'end_header'.length);
  const headerLines = headerText.split(/\r?\n/);

  let format = null; // 'ascii', 'binary_little_endian', 'binary_big_endian'
  let vertexCount = 0;
  let vertexPropertyOrder = [];
  let vertexPropertyTypes = [];
  let inVertexElement = false;

  for (const line of headerLines) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length === 0) continue;

    if (tokens[0] === 'format') {
      format = tokens[1]; // ascii / binary_little_endian / binary_big_endian
    }

    if (tokens[0] === 'element' && tokens[1] === 'vertex') {
      vertexCount = parseInt(tokens[2], 10);
      inVertexElement = true;
      continue;
    }

    if (tokens[0] === 'element' && tokens[1] !== 'vertex') {
      // new element, stop reading vertex properties
      inVertexElement = false;
    }

    if (inVertexElement && tokens[0] === 'property') {
      // Example: property float x
      // tokens: ['property', 'float', 'x']
      const type = tokens[1];
      const name = tokens[tokens.length - 1]; // last token is the property name
      vertexPropertyOrder.push(name);
      vertexPropertyTypes.push(type);
    }
  }

  if (!format) {
    throw new Error('PLY format not specified in header.');
  }
  if (!vertexCount) {
    throw new Error('PLY vertex element not found or vertex count is 0.');
  }

  const headerLength = headerEndIndex + 'end_header'.length;
  const headerBytes = headerLength;
  const dataStart = headerBytes + textHeader.slice(headerLength).search(/\S|$/); // skip trailing newlines

  const bufferView = new DataView(buffer, dataStart);
  const isLittleEndian = format === 'binary_little_endian';

  // Identify indices of known properties
  const xIndex = vertexPropertyOrder.indexOf('x');
  const yIndex = vertexPropertyOrder.indexOf('y');
  const zIndex = vertexPropertyOrder.indexOf('z');

  const rIndex = vertexPropertyOrder.indexOf('red') !== -1
    ? vertexPropertyOrder.indexOf('red')
    : vertexPropertyOrder.indexOf('r');

  const gIndex = vertexPropertyOrder.indexOf('green') !== -1
    ? vertexPropertyOrder.indexOf('green')
    : vertexPropertyOrder.indexOf('g');

  const bIndex = vertexPropertyOrder.indexOf('blue') !== -1
    ? vertexPropertyOrder.indexOf('blue')
    : vertexPropertyOrder.indexOf('b');

  if (xIndex === -1 || yIndex === -1 || zIndex === -1) {
    throw new Error('PLY vertex does not contain x/y/z properties.');
  }

  const hasColor = rIndex !== -1 && gIndex !== -1 && bIndex !== -1;

  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);

  if (format === 'ascii') {
    // ASCII PLY: data after end_header is text
    const asciiData = new TextDecoder('ascii').decode(
      buffer.slice(dataStart)
    );
    const lines = asciiData.split(/\r?\n/);
    let v = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      const tokens = line.trim().split(/\s+/);
      if (tokens.length < vertexPropertyOrder.length) continue;

      if (v >= vertexCount) break;

      // x, y, z
      positions[3 * v + 0] = parseFloat(tokens[xIndex]);
      positions[3 * v + 1] = parseFloat(tokens[yIndex]);
      positions[3 * v + 2] = parseFloat(tokens[zIndex]);

      if (hasColor) {
        const r = parseFloat(tokens[rIndex]) / 255.0;
        const g = parseFloat(tokens[gIndex]) / 255.0;
        const b = parseFloat(tokens[bIndex]) / 255.0;
        colors[3 * v + 0] = r;
        colors[3 * v + 1] = g;
        colors[3 * v + 2] = b;
      } else {
        colors[3 * v + 0] = 1.0;
        colors[3 * v + 1] = 1.0;
        colors[3 * v + 2] = 1.0;
      }

      v++;
    }
  } else if (format === 'binary_little_endian' || format === 'binary_big_endian') {
    // Binary PLY
    function readProperty(type, offset, littleEndian) {
      switch (type) {
        case 'float':
        case 'float32':
          return bufferView.getFloat32(offset, littleEndian);
        case 'double':
        case 'float64':
          return bufferView.getFloat64(offset, littleEndian);
        case 'uchar':
        case 'uint8':
          return bufferView.getUint8(offset);
        case 'char':
        case 'int8':
          return bufferView.getInt8(offset);
        case 'ushort':
        case 'uint16':
          return bufferView.getUint16(offset, littleEndian);
        case 'short':
        case 'int16':
          return bufferView.getInt16(offset, littleEndian);
        case 'uint':
        case 'uint32':
          return bufferView.getUint32(offset, littleEndian);
        case 'int':
        case 'int32':
          return bufferView.getInt32(offset, littleEndian);
        default:
          // unsupported type; treat as 4 bytes
          return bufferView.getFloat32(offset, littleEndian);
      }
    }

    function propertySize(type) {
      switch (type) {
        case 'float':
        case 'float32':
        case 'int':
        case 'int32':
        case 'uint':
        case 'uint32':
          return 4;
        case 'double':
        case 'float64':
          return 8;
        case 'short':
        case 'int16':
        case 'ushort':
        case 'uint16':
          return 2;
        case 'char':
        case 'int8':
        case 'uchar':
        case 'uint8':
          return 1;
        default:
          return 4;
      }
    }

    const little = isLittleEndian;

    // Compute bytes per vertex
    let bytesPerVertex = 0;
    for (const t of vertexPropertyTypes) {
      bytesPerVertex += propertySize(t);
    }

    let offset = 0;
    for (let v = 0; v < vertexCount; v++) {
      let propertyOffset = offset;
      let x = 0, y = 0, z = 0;
      let r = 1, g = 1, b = 1;

      for (let i = 0; i < vertexPropertyOrder.length; i++) {
        const name = vertexPropertyOrder[i];
        const type = vertexPropertyTypes[i];
        const value = readProperty(type, propertyOffset, little);
        propertyOffset += propertySize(type);

        if (name === 'x') x = value;
        if (name === 'y') y = value;
        if (name === 'z') z = value;

        if (hasColor) {
          if (name === 'red' || name === 'r') r = value / 255.0;
          if (name === 'green' || name === 'g') g = value / 255.0;
          if (name === 'blue' || name === 'b') b = value / 255.0;
        }
      }

      positions[3 * v + 0] = x;
      positions[3 * v + 1] = y;
      positions[3 * v + 2] = z;

      colors[3 * v + 0] = r;
      colors[3 * v + 1] = g;
      colors[3 * v + 2] = b;

      offset += bytesPerVertex;
    }
  } else {
    throw new Error(`Unsupported PLY format: ${format}`);
  }

  return { positions, colors, vertexCount };
}

/**
 * Minimal placeholder loader for "Gaussian splat" data.
 *
 * If the buffer is PLY, it parses PLY. Otherwise, it expects a binary file:
 *   Float32Array: [x,y,z,r,g,b, x,y,z,r,g,b, ...]
 * with r,g,b in 0..1 range.
 *
 * Returns a THREE.Points object you can add to the scene.
 */
export function loadSimpleSplatFromArrayBuffer(buffer, material) {
  let positions, colors, count;

  if (isPlyBuffer(buffer)) {
    console.log('Detected PLY format.');
    const plyData = parsePly(buffer);
    positions = plyData.positions;
    colors = plyData.colors;
    count = plyData.vertexCount;
  } else {
    console.log('Assuming raw Float32 xyzrgb format.');
    const floats = new Float32Array(buffer);

    if (floats.length % 6 !== 0) {
      console.warn(
        'Expected Float32 xyzrgb per point (6 floats), but got length =',
        floats.length
      );
    }

    count = Math.floor(floats.length / 6);
    if (count === 0) {
      console.warn('No points detected in buffer.');
      return null;
    }

    positions = new Float32Array(count * 3);
    colors = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      positions[3 * i + 0] = floats[6 * i + 0];
      positions[3 * i + 1] = floats[6 * i + 1];
      positions[3 * i + 2] = floats[6 * i + 2];

      colors[3 * i + 0] = floats[6 * i + 3];
      colors[3 * i + 1] = floats[6 * i + 4];
      colors[3 * i + 2] = floats[6 * i + 5];
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  geometry.computeBoundingSphere();

  return points;
}