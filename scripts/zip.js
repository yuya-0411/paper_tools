(function (root) {
  "use strict";

  var PaperTools = (root.PaperTools = root.PaperTools || {});
  var UTF8_FLAG = 0x0800;
  var MAX_UINT16 = 0xffff;
  var MAX_UINT32 = 0xffffffff;
  var crcTable = null;

  function encodeUtf8(value) {
    var text = String(value);
    if (typeof root.TextEncoder === "function") {
      return new root.TextEncoder().encode(text);
    }

    var bytes = [];
    for (var index = 0; index < text.length; index += 1) {
      var codePoint = text.charCodeAt(index);
      if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < text.length) {
        var low = text.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
          index += 1;
        } else {
          codePoint = 0xfffd;
        }
      } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
        codePoint = 0xfffd;
      }

      if (codePoint <= 0x7f) {
        bytes.push(codePoint);
      } else if (codePoint <= 0x7ff) {
        bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
      } else if (codePoint <= 0xffff) {
        bytes.push(
          0xe0 | (codePoint >> 12),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f),
        );
      } else {
        bytes.push(
          0xf0 | (codePoint >> 18),
          0x80 | ((codePoint >> 12) & 0x3f),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f),
        );
      }
    }
    return new Uint8Array(bytes);
  }

  function decodeUtf8(bytes) {
    if (typeof root.TextDecoder === "function") {
      return new root.TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    var encoded = "";
    for (var index = 0; index < bytes.length; index += 1) {
      encoded += "%" + bytes[index].toString(16).padStart(2, "0");
    }
    return decodeURIComponent(encoded);
  }

  function normalizePath(input) {
    if (typeof input !== "string" || input.length === 0 || input.indexOf("\0") !== -1) {
      throw new TypeError("ZIP entry path must be a non-empty string without NUL bytes");
    }

    var replaced = input.replace(/\\/g, "/");
    if (
      replaced.charAt(0) === "/" ||
      replaced.indexOf("//") === 0 ||
      /^[A-Za-z]:/.test(replaced) ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(replaced)
    ) {
      throw new Error("Absolute ZIP entry paths are not allowed: " + input);
    }

    var normalized = [];
    var parts = replaced.split("/");
    for (var index = 0; index < parts.length; index += 1) {
      var part = parts[index];
      if (part === "" || part === ".") {
        continue;
      }
      if (part === "..") {
        throw new Error("ZIP entry path traversal is not allowed: " + input);
      }
      if (part.indexOf(":") !== -1 || /[\x00-\x1f]/.test(part)) {
        throw new Error("Unsafe ZIP entry path segment: " + input);
      }
      normalized.push(part);
    }

    if (normalized.length === 0 || replaced.charAt(replaced.length - 1) === "/") {
      throw new Error("ZIP entry path must name a file: " + input);
    }
    return normalized.join("/");
  }

  function makeCrcTable() {
    var table = new Uint32Array(256);
    for (var number = 0; number < 256; number += 1) {
      var current = number;
      for (var bit = 0; bit < 8; bit += 1) {
        current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
      }
      table[number] = current >>> 0;
    }
    return table;
  }

  function crc32(bytes) {
    crcTable = crcTable || makeCrcTable();
    var crc = 0xffffffff;
    for (var index = 0; index < bytes.length; index += 1) {
      crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function isArrayBuffer(value) {
    return typeof root.ArrayBuffer === "function" && value instanceof root.ArrayBuffer;
  }

  function isArrayBufferView(value) {
    return (
      typeof root.ArrayBuffer === "function" &&
      typeof root.ArrayBuffer.isView === "function" &&
      root.ArrayBuffer.isView(value)
    );
  }

  async function toBytes(value) {
    if (value === undefined || value === null) {
      return new Uint8Array(0);
    }
    if (typeof value === "string") {
      return encodeUtf8(value);
    }
    if (value instanceof Uint8Array) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (isArrayBuffer(value)) {
      return new Uint8Array(value);
    }
    if (isArrayBufferView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (value && typeof value.arrayBuffer === "function") {
      var buffer = await value.arrayBuffer();
      if (!isArrayBuffer(buffer)) {
        throw new TypeError("arrayBuffer() did not return an ArrayBuffer");
      }
      return new Uint8Array(buffer);
    }
    throw new TypeError("ZIP entry data must be a string, Blob, ArrayBuffer, or typed array");
  }

  function dosTimestamp(input) {
    var date = input === undefined || input === null ? new Date(Date.UTC(1980, 0, 1)) : new Date(input);
    if (Number.isNaN(date.getTime())) {
      date = new Date(Date.UTC(1980, 0, 1));
    }
    var year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
    var dosDate = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
    var dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
    return { date: dosDate, time: dosTime };
  }

  function setUint16(view, offset, value) {
    view.setUint16(offset, value, true);
  }

  function setUint32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }

  function normalizeFiles(files) {
    if (Array.isArray(files)) {
      return files.map(function (entry) {
        if (Array.isArray(entry) && entry.length >= 2) {
          return { name: entry[0], data: entry[1] };
        }
        if (entry && typeof entry === "object") {
          var name = entry.path !== undefined ? entry.path : entry.name;
          var data = entry.data;
          if (data === undefined && entry.content !== undefined) {
            data = entry.content;
          }
          if (data === undefined && typeof entry.arrayBuffer === "function") {
            data = entry;
          }
          return { name: name, data: data, lastModified: entry.lastModified };
        }
        throw new TypeError("Each ZIP entry must be an object or [path, data] pair");
      });
    }
    if (files && typeof files === "object") {
      return Object.keys(files).map(function (name) {
        return { name: name, data: files[name] };
      });
    }
    throw new TypeError("createZip expects an array of entries or a path-to-data object");
  }

  async function extractZip(input, options) {
    var config = options || {};
    var maxBytes = Math.max(1, Number(config.maxBytes) || 200 * 1024 * 1024);
    var maxEntries = Math.max(1, Number(config.maxEntries) || 2048);
    var bytes = await toBytes(input);
    if (bytes.byteLength > maxBytes) {
      throw new RangeError("ZIP archive exceeds the allowed size");
    }
    if (bytes.byteLength < 22) {
      throw new Error("Invalid ZIP archive: end record is missing");
    }
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var searchStart = Math.max(0, bytes.byteLength - 22 - MAX_UINT16);
    var endOffset = -1;
    for (var cursor = bytes.byteLength - 22; cursor >= searchStart; cursor -= 1) {
      if (view.getUint32(cursor, true) === 0x06054b50) {
        endOffset = cursor;
        break;
      }
    }
    if (endOffset < 0) {
      throw new Error("Invalid ZIP archive: end record is missing");
    }
    if (view.getUint16(endOffset + 4, true) !== 0 || view.getUint16(endOffset + 6, true) !== 0) {
      throw new Error("Multi-disk ZIP archives are not supported");
    }
    var entryCount = view.getUint16(endOffset + 10, true);
    var centralSize = view.getUint32(endOffset + 12, true);
    var centralOffset = view.getUint32(endOffset + 16, true);
    if (entryCount > maxEntries) {
      throw new RangeError("ZIP archive contains too many entries");
    }
    if (centralOffset + centralSize > endOffset || centralOffset > bytes.byteLength) {
      throw new Error("Invalid ZIP archive: central directory is outside the file");
    }

    var result = Object.create(null);
    var position = centralOffset;
    var totalExtracted = 0;
    for (var entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
      if (position + 46 > bytes.byteLength || view.getUint32(position, true) !== 0x02014b50) {
        throw new Error("Invalid ZIP archive: central directory entry is malformed");
      }
      var flags = view.getUint16(position + 8, true);
      var method = view.getUint16(position + 10, true);
      var expectedCrc = view.getUint32(position + 16, true);
      var compressedSize = view.getUint32(position + 20, true);
      var uncompressedSize = view.getUint32(position + 24, true);
      var nameLength = view.getUint16(position + 28, true);
      var extraLength = view.getUint16(position + 30, true);
      var commentLength = view.getUint16(position + 32, true);
      var diskNumber = view.getUint16(position + 34, true);
      var localOffset = view.getUint32(position + 42, true);
      var nextPosition = position + 46 + nameLength + extraLength + commentLength;
      if (nextPosition > bytes.byteLength) {
        throw new Error("Invalid ZIP archive: entry metadata is truncated");
      }
      if (diskNumber !== 0 || flags & 0x0001) {
        throw new Error("Encrypted or multi-disk ZIP entries are not supported");
      }
      if (method !== 0 || compressedSize !== uncompressedSize) {
        throw new Error("Only uncompressed paper_tools ZIP backups are supported");
      }
      var rawName = bytes.subarray(position + 46, position + 46 + nameLength);
      var path = normalizePath(decodeUtf8(rawName));
      if (Object.prototype.hasOwnProperty.call(result, path)) {
        throw new Error("Duplicate ZIP entry path: " + path);
      }
      if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) {
        throw new Error("Invalid ZIP archive: local entry is missing");
      }
      if (view.getUint16(localOffset + 8, true) !== method) {
        throw new Error("Invalid ZIP archive: compression methods disagree");
      }
      var localNameLength = view.getUint16(localOffset + 26, true);
      var localExtraLength = view.getUint16(localOffset + 28, true);
      var dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      var dataEnd = dataOffset + compressedSize;
      if (dataEnd > bytes.byteLength) {
        throw new Error("Invalid ZIP archive: entry data is truncated");
      }
      totalExtracted += uncompressedSize;
      if (totalExtracted > maxBytes) {
        throw new RangeError("ZIP archive expands beyond the allowed size");
      }
      var data = bytes.slice(dataOffset, dataEnd);
      if (crc32(data) !== expectedCrc) {
        throw new Error("ZIP entry failed its integrity check: " + path);
      }
      result[path] = data;
      position = nextPosition;
    }
    return result;
  }

  async function createZip(files) {
    var inputEntries = normalizeFiles(files);
    var maxArchiveBytes = Math.max(1, Number(PaperTools.MAX_BACKUP_BYTES) || 100 * 1024 * 1024);
    var maxArchiveEntries = Math.max(1, Number(PaperTools.MAX_BACKUP_ENTRIES) || 2048);
    if (inputEntries.length > Math.min(MAX_UINT16, maxArchiveEntries)) {
      throw new RangeError("ZIP backup contains too many entries");
    }

    var entries = [];
    var seenPaths = Object.create(null);
    var aggregateDataSize = 0;
    for (var index = 0; index < inputEntries.length; index += 1) {
      var input = inputEntries[index];
      var path = normalizePath(input.name);
      if (seenPaths[path]) {
        throw new Error("Duplicate ZIP entry path: " + path);
      }
      seenPaths[path] = true;
      var nameBytes = encodeUtf8(path);
      if (nameBytes.length > MAX_UINT16) {
        throw new RangeError("ZIP entry path is too long: " + path);
      }
      var data = await toBytes(input.data);
      if (data.byteLength > MAX_UINT32) {
        throw new RangeError("ZIP64 is not supported; entry is too large: " + path);
      }
      aggregateDataSize += data.byteLength;
      if (aggregateDataSize > maxArchiveBytes) {
        throw new RangeError("ZIP backup exceeds the supported 100 MB limit");
      }
      entries.push({
        path: path,
        nameBytes: nameBytes,
        data: data,
        crc: crc32(data),
        timestamp: dosTimestamp(input.lastModified),
        offset: 0,
      });
    }

    var localParts = [];
    var localSize = 0;
    entries.forEach(function (entry) {
      entry.offset = localSize;
      var header = new Uint8Array(30 + entry.nameBytes.length);
      var view = new DataView(header.buffer);
      setUint32(view, 0, 0x04034b50);
      setUint16(view, 4, 20);
      setUint16(view, 6, UTF8_FLAG);
      setUint16(view, 8, 0);
      setUint16(view, 10, entry.timestamp.time);
      setUint16(view, 12, entry.timestamp.date);
      setUint32(view, 14, entry.crc);
      setUint32(view, 18, entry.data.byteLength);
      setUint32(view, 22, entry.data.byteLength);
      setUint16(view, 26, entry.nameBytes.length);
      setUint16(view, 28, 0);
      header.set(entry.nameBytes, 30);
      localParts.push(header, entry.data);
      localSize += header.byteLength + entry.data.byteLength;
      if (localSize > MAX_UINT32) {
        throw new RangeError("ZIP64 is not supported; archive is too large");
      }
    });

    var centralParts = [];
    var centralSize = 0;
    entries.forEach(function (entry) {
      var header = new Uint8Array(46 + entry.nameBytes.length);
      var view = new DataView(header.buffer);
      setUint32(view, 0, 0x02014b50);
      setUint16(view, 4, 20);
      setUint16(view, 6, 20);
      setUint16(view, 8, UTF8_FLAG);
      setUint16(view, 10, 0);
      setUint16(view, 12, entry.timestamp.time);
      setUint16(view, 14, entry.timestamp.date);
      setUint32(view, 16, entry.crc);
      setUint32(view, 20, entry.data.byteLength);
      setUint32(view, 24, entry.data.byteLength);
      setUint16(view, 28, entry.nameBytes.length);
      setUint16(view, 30, 0);
      setUint16(view, 32, 0);
      setUint16(view, 34, 0);
      setUint16(view, 36, 0);
      setUint32(view, 38, 0);
      setUint32(view, 42, entry.offset);
      header.set(entry.nameBytes, 46);
      centralParts.push(header);
      centralSize += header.byteLength;
    });

    if (centralSize > MAX_UINT32 || localSize + centralSize > MAX_UINT32) {
      throw new RangeError("ZIP64 is not supported; archive is too large");
    }

    var end = new Uint8Array(22);
    var endView = new DataView(end.buffer);
    setUint32(endView, 0, 0x06054b50);
    setUint16(endView, 4, 0);
    setUint16(endView, 6, 0);
    setUint16(endView, 8, entries.length);
    setUint16(endView, 10, entries.length);
    setUint32(endView, 12, centralSize);
    setUint32(endView, 16, localSize);
    setUint16(endView, 20, 0);

    var totalSize = localSize + centralSize + end.byteLength;
    if (totalSize > maxArchiveBytes) {
      throw new RangeError("ZIP backup exceeds the supported 100 MB limit");
    }
    var output = new Uint8Array(totalSize);
    var cursor = 0;
    localParts.concat(centralParts, [end]).forEach(function (part) {
      output.set(part, cursor);
      cursor += part.byteLength;
    });

    if (typeof root.Blob === "function") {
      return new root.Blob([output], { type: "application/zip" });
    }
    return output;
  }

  PaperTools.createZip = createZip;
  PaperTools.extractZip = extractZip;
})(typeof globalThis !== "undefined" ? globalThis : this);
