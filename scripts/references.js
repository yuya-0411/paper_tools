(function (root, factory) {
  "use strict";
  var namespace = root.PaperTools || {};
  var api = factory(namespace);
  root.PaperTools = Object.assign(namespace, api);
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (PaperTools) {
  "use strict";

  var MAX_BIBTEX_BYTES = 2 * 1024 * 1024;
  // Every imported record becomes an editable form, so bound the count to keep
  // a valid but huge .bib file from freezing the dependency-free UI.
  var MAX_BIBTEX_ENTRIES = 500;
  var MAX_NESTING_DEPTH = 128;
  var IGNORED_ENTRY_TYPES = Object.freeze({
    comment: true,
    preamble: true,
  });
  var TEX_COMBINING_ACCENTS = Object.freeze({
    "'": "\u0301",
    "`": "\u0300",
    "^": "\u0302",
    '"': "\u0308",
    "~": "\u0303",
    "=": "\u0304",
    ".": "\u0307",
    u: "\u0306",
    v: "\u030c",
    H: "\u030b",
    c: "\u0327",
    k: "\u0328",
    r: "\u030a",
    d: "\u0323",
    b: "\u0331",
  });
  var TEX_SPECIAL_CHARACTERS = Object.freeze({
    AA: "Å",
    aa: "å",
    AE: "Æ",
    ae: "æ",
    OE: "Œ",
    oe: "œ",
    O: "Ø",
    o: "ø",
    L: "Ł",
    l: "ł",
    ss: "ß",
    i: "ı",
    j: "ȷ",
  });
  var VENUE_FIELDS = ["journal", "booktitle", "publisher", "institution", "school", "organization"];
  var KEPT_FIELDS = Object.freeze({
    title: true,
    author: true,
    year: true,
    date: true,
    journal: true,
    booktitle: true,
    publisher: true,
    institution: true,
    school: true,
    organization: true,
    doi: true,
    url: true,
    note: true,
  });

  function configuredLimit(options, optionName, namespaceName, fallback) {
    var candidate = options && options[optionName] !== undefined
      ? Number(options[optionName])
      : Number(PaperTools[namespaceName]);
    return Number.isFinite(candidate) && candidate > 0 ? Math.floor(candidate) : fallback;
  }

  function exceedsUtf8Limit(source, limit) {
    var bytes = 0;
    for (var index = 0; index < source.length; index += 1) {
      var code = source.charCodeAt(index);
      if (code <= 0x7f) {
        bytes += 1;
      } else if (code <= 0x7ff) {
        bytes += 2;
      } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < source.length) {
        var next = source.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          index += 1;
        } else {
          bytes += 3;
        }
      } else {
        bytes += 3;
      }
      if (bytes > limit) return true;
    }
    return false;
  }

  function syntaxError(message, index) {
    return new SyntaxError(message + " at offset " + index);
  }

  function isIdentifierCharacter(character) {
    return Boolean(character && /[A-Za-z0-9_:-]/.test(character));
  }

  function skipTrivia(source, index, end) {
    while (index < end) {
      if (/\s/.test(source[index])) {
        index += 1;
        continue;
      }
      if (source[index] === "%") {
        while (index < end && source[index] !== "\n" && source[index] !== "\r") index += 1;
        continue;
      }
      break;
    }
    return index;
  }

  function readIdentifier(source, index, end) {
    var start = index;
    while (index < end && isIdentifierCharacter(source[index])) index += 1;
    return { value: source.slice(start, index), index: index };
  }

  function skipIgnoredEntry(source, index, opener, maxDepth) {
    var closer = opener === "{" ? "}" : ")";
    var depth = 1;
    var braceDepth = 0;
    var inQuote = false;

    while (index < source.length) {
      var character = source[index];
      if (character === "\\") {
        index += Math.min(2, source.length - index);
        continue;
      }
      if (character === '"') {
        inQuote = !inQuote;
        index += 1;
        continue;
      }
      if (inQuote) {
        index += 1;
        continue;
      }

      if (opener === "{") {
        if (character === "{") {
          depth += 1;
          if (depth > maxDepth) throw new RangeError("BibTeX nesting is too deep");
        } else if (character === closer) {
          depth -= 1;
          if (depth === 0) return index + 1;
        }
      } else if (character === "{") {
        braceDepth += 1;
        if (braceDepth > maxDepth) throw new RangeError("BibTeX nesting is too deep");
      } else if (character === "}" && braceDepth > 0) {
        braceDepth -= 1;
      } else if (braceDepth === 0 && character === opener) {
        depth += 1;
        if (depth > maxDepth) throw new RangeError("BibTeX nesting is too deep");
      } else if (braceDepth === 0 && character === closer) {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      index += 1;
    }
    throw syntaxError("Unterminated ignored BibTeX entry", index);
  }

  function parseBracedValue(source, index, maxDepth) {
    var output = "";
    var depth = 1;
    index += 1;
    while (index < source.length) {
      var character = source[index];
      if (character === "\\") {
        output += character;
        index += 1;
        if (index < source.length) {
          output += source[index];
          index += 1;
        }
        continue;
      }
      if (character === "{") {
        depth += 1;
        if (depth > maxDepth) throw new RangeError("BibTeX nesting is too deep");
        output += character;
        index += 1;
        continue;
      }
      if (character === "}") {
        depth -= 1;
        index += 1;
        if (depth === 0) return { value: output, index: index };
        output += character;
        continue;
      }
      output += character;
      index += 1;
    }
    throw syntaxError("Unterminated braced BibTeX value", index);
  }

  function parseQuotedValue(source, index, maxDepth) {
    var output = "";
    var braceDepth = 0;
    index += 1;
    while (index < source.length) {
      var character = source[index];
      if (character === "\\") {
        output += character;
        index += 1;
        if (index < source.length) {
          output += source[index];
          index += 1;
        }
        continue;
      }
      if (character === "{") {
        braceDepth += 1;
        if (braceDepth > maxDepth) throw new RangeError("BibTeX nesting is too deep");
        output += character;
        index += 1;
        continue;
      }
      if (character === "}") {
        if (braceDepth === 0) throw syntaxError("Unmatched brace in quoted BibTeX value", index);
        braceDepth -= 1;
        output += character;
        index += 1;
        continue;
      }
      if (character === '"' && braceDepth === 0) {
        return { value: output, index: index + 1 };
      }
      output += character;
      index += 1;
    }
    throw syntaxError("Unterminated quoted BibTeX value", index);
  }

  function parseBareValue(source, index, closer) {
    var start = index;
    while (index < source.length && !/[\s,#%]/.test(source[index]) && source[index] !== closer) index += 1;
    if (index === start) throw syntaxError("Expected a BibTeX value", index);
    return { value: source.slice(start, index), index: index };
  }

  function parseValue(source, index, closer, maxDepth) {
    var pieces = [];
    while (index < source.length) {
      index = skipTrivia(source, index, source.length);
      var part;
      var isMacro = false;
      if (source[index] === "{") {
        part = parseBracedValue(source, index, maxDepth);
      } else if (source[index] === '"') {
        part = parseQuotedValue(source, index, maxDepth);
      } else {
        part = parseBareValue(source, index, closer);
        isMacro = true;
      }
      pieces.push({ value: part.value, isMacro: isMacro });
      index = skipTrivia(source, part.index, source.length);
      if (source[index] !== "#") break;
      index += 1;
    }
    return { pieces: pieces, index: index };
  }

  function cleanText(value, maxLength) {
    var cleaned = typeof PaperTools.plainText === "function"
      ? PaperTools.plainText(value, maxLength)
      : String(value == null ? "" : value).replace(/\u0000/g, "").slice(0, maxLength);
    return cleaned.replace(/\s+/g, " ").trim();
  }

  function isAsciiLetter(character) {
    return Boolean(character && /[A-Za-z]/.test(character));
  }

  function readTexAccentArgument(source, index) {
    while (index < source.length && /\s/.test(source[index])) index += 1;
    var grouped = source[index] === "{";
    if (grouped) {
      index += 1;
      while (index < source.length && /\s/.test(source[index])) index += 1;
    }

    var base = "";
    if (source[index] === "\\" && (source[index + 1] === "i" || source[index + 1] === "j")) {
      base = source[index + 1];
      index += 2;
    } else if (isAsciiLetter(source[index])) {
      base = source[index];
      index += 1;
    } else {
      return null;
    }

    if (grouped) {
      while (index < source.length && /\s/.test(source[index])) index += 1;
      if (source[index] !== "}") return null;
      index += 1;
    }
    return { base: base, index: index };
  }

  function decodeTexText(value) {
    var source = String(value == null ? "" : value);
    var output = "";
    var index = 0;
    while (index < source.length) {
      if (source[index] !== "\\" || index + 1 >= source.length) {
        output += source[index];
        index += 1;
        continue;
      }

      var commandStart = index + 1;
      var commandEnd = commandStart + 1;
      var command = source[commandStart];
      if (isAsciiLetter(command)) {
        while (commandEnd < source.length && isAsciiLetter(source[commandEnd])) commandEnd += 1;
        command = source.slice(commandStart, commandEnd);
      }

      if (Object.prototype.hasOwnProperty.call(TEX_SPECIAL_CHARACTERS, command)) {
        output += TEX_SPECIAL_CHARACTERS[command];
        index = commandEnd;
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(TEX_COMBINING_ACCENTS, command)) {
        var argument = readTexAccentArgument(source, commandEnd);
        if (argument) {
          var combined = argument.base + TEX_COMBINING_ACCENTS[command];
          output += typeof combined.normalize === "function" ? combined.normalize("NFC") : combined;
          index = argument.index;
          continue;
        }
      }

      output += source.slice(index, commandEnd);
      index = commandEnd;
    }
    return output;
  }

  function cleanDisplayText(value, maxLength) {
    var source = decodeTexText(value);
    var output = "";
    for (var index = 0; index < source.length; index += 1) {
      var character = source[index];
      if (character === "\\") {
        output += character;
        if (index + 1 < source.length) {
          output += source[index + 1];
          index += 1;
        }
      } else if (character !== "{" && character !== "}") {
        output += character;
      }
    }
    return cleanText(output, maxLength);
  }

  function normalizeKey(value) {
    if (typeof PaperTools.normalizeCitationKey === "function") {
      return PaperTools.normalizeCitationKey(value);
    }
    return cleanText(value, 120).replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/^[.:-]+|[.:-]+$/g, "");
  }

  function firstField(fields, names) {
    for (var index = 0; index < names.length; index += 1) {
      if (fields[names[index]]) return fields[names[index]];
    }
    return "";
  }

  function buildReference(entryType, rawKey, fields) {
    var type = cleanText(entryType, 40).toLowerCase().replace(/[^a-z0-9_-]/g, "") || "misc";
    return {
      key: normalizeKey(rawKey),
      type: type,
      title: cleanDisplayText(fields.title, 1000),
      authors: cleanDisplayText(fields.author, 1000),
      year: cleanDisplayText(fields.year || fields.date, 10),
      venue: cleanDisplayText(firstField(fields, VENUE_FIELDS), 1000),
      doi: cleanDisplayText(fields.doi, 300),
      url: cleanDisplayText(fields.url, 2000),
      note: cleanDisplayText(fields.note, 3000),
    };
  }

  function parseEntry(source, index, entryType, opener, maxDepth) {
    var closer = opener === "{" ? "}" : ")";
    var fields = Object.create(null);
    index = skipTrivia(source, index, source.length);
    var keyStart = index;
    while (index < source.length && source[index] !== "," && source[index] !== closer) index += 1;
    if (index >= source.length) throw syntaxError("Unterminated BibTeX entry", index);
    var rawKey = source.slice(keyStart, index).trim();
    if (!normalizeKey(rawKey)) throw syntaxError("BibTeX citation key is empty or invalid", keyStart);

    if (source[index] === closer) {
      return { entryType: entryType, rawKey: rawKey, fields: fields, index: index + 1 };
    }
    index += 1;

    while (index < source.length) {
      index = skipTrivia(source, index, source.length);
      while (source[index] === ",") {
        index = skipTrivia(source, index + 1, source.length);
      }
      if (source[index] === closer) {
        return { entryType: entryType, rawKey: rawKey, fields: fields, index: index + 1 };
      }
      if (index >= source.length) break;

      var fieldStart = index;
      var identifier = readIdentifier(source, index, source.length);
      if (!identifier.value) throw syntaxError("Expected a BibTeX field name", fieldStart);
      var fieldName = identifier.value.toLowerCase();
      index = skipTrivia(source, identifier.index, source.length);
      if (source[index] !== "=") throw syntaxError('Expected "=" after BibTeX field name', index);
      index = skipTrivia(source, index + 1, source.length);
      var parsedValue = parseValue(source, index, closer, maxDepth);
      if (KEPT_FIELDS[fieldName] && fields[fieldName] === undefined) fields[fieldName] = parsedValue.pieces;
      index = skipTrivia(source, parsedValue.index, source.length);
      if (source[index] === ",") {
        index += 1;
      } else if (source[index] !== closer) {
        throw syntaxError("Expected a comma or the end of the BibTeX entry", index);
      }
    }
    throw syntaxError("Unterminated BibTeX entry", index);
  }

  function parseStringEntry(source, index, opener, maxDepth) {
    var closer = opener === "{" ? "}" : ")";
    var definitions = [];
    while (index < source.length) {
      index = skipTrivia(source, index, source.length);
      while (source[index] === ",") index = skipTrivia(source, index + 1, source.length);
      if (source[index] === closer) return { definitions: definitions, index: index + 1 };

      var nameStart = index;
      var identifier = readIdentifier(source, index, source.length);
      if (!identifier.value) throw syntaxError("Expected a BibTeX @string name", nameStart);
      index = skipTrivia(source, identifier.index, source.length);
      if (source[index] !== "=") throw syntaxError('Expected "=" after BibTeX @string name', index);
      index = skipTrivia(source, index + 1, source.length);
      var parsedValue = parseValue(source, index, closer, maxDepth);
      definitions.push({ name: identifier.value.toLowerCase(), pieces: parsedValue.pieces });
      index = skipTrivia(source, parsedValue.index, source.length);
      if (source[index] === ",") {
        index += 1;
      } else if (source[index] !== closer) {
        throw syntaxError("Expected a comma or the end of the BibTeX @string entry", index);
      }
    }
    throw syntaxError("Unterminated BibTeX @string entry", index);
  }

  function appendExpandedValue(output, value, state) {
    state.expandedCharacters += value.length;
    if (state.expandedCharacters > state.maxExpandedCharacters || output.length + value.length > state.maxExpandedCharacters) {
      throw new RangeError("BibTeX macro expansion exceeds the size limit");
    }
    return output + value;
  }

  function resolveMacro(name, state, depth) {
    if (Object.prototype.hasOwnProperty.call(state.cache, name)) return state.cache[name];
    if (state.resolving[name]) {
      throw new Error("Circular BibTeX @string macro: " + state.stack.concat([name]).join(" -> "));
    }
    if (depth >= state.maxDepth) throw new RangeError("BibTeX macro expansion is too deep");

    state.resolving[name] = true;
    state.stack.push(name);
    try {
      var resolved = resolveValue(state.macros[name], state, depth + 1);
      state.cache[name] = resolved;
      return resolved;
    } finally {
      state.stack.pop();
      delete state.resolving[name];
    }
  }

  function resolveValue(pieces, state, depth) {
    var output = "";
    for (var index = 0; index < pieces.length; index += 1) {
      var piece = pieces[index];
      var value = piece.value;
      if (piece.isMacro) {
        var macroName = value.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(state.macros, macroName)) {
          value = resolveMacro(macroName, state, depth);
        }
        // Undefined macros are intentionally retained verbatim. Silently
        // converting them to an empty string would corrupt imported metadata.
      }
      output = appendExpandedValue(output, value, state);
    }
    return output;
  }

  function resolveFields(fields, state) {
    var resolved = Object.create(null);
    Object.keys(fields).forEach(function (fieldName) {
      resolved[fieldName] = resolveValue(fields[fieldName], state, 0);
    });
    return resolved;
  }

  function parseBibtex(input, options) {
    if (typeof input !== "string") throw new TypeError("BibTeX input must be a string");
    var maxBytes = configuredLimit(options, "maxBytes", "MAX_BIBTEX_BYTES", MAX_BIBTEX_BYTES);
    var maxEntries = configuredLimit(options, "maxEntries", "MAX_BIBTEX_ENTRIES", MAX_BIBTEX_ENTRIES);
    var maxDepth = configuredLimit(options, "maxDepth", "MAX_BIBTEX_NESTING_DEPTH", MAX_NESTING_DEPTH);
    if (exceedsUtf8Limit(input, maxBytes)) throw new RangeError("BibTeX input exceeds the size limit");

    var entries = [];
    var macros = Object.create(null);
    var index = 0;
    while (index < input.length) {
      index = skipTrivia(input, index, input.length);
      if (index >= input.length) break;
      if (input[index] !== "@") {
        index += 1;
        continue;
      }

      var marker = index;
      index = skipTrivia(input, index + 1, input.length);
      var identifier = readIdentifier(input, index, input.length);
      if (!identifier.value) {
        index = marker + 1;
        continue;
      }
      var entryType = identifier.value.toLowerCase();
      index = skipTrivia(input, identifier.index, input.length);
      var opener = input[index];
      if (opener !== "{" && opener !== "(") {
        if (entryType === "comment") {
          while (index < input.length && input[index] !== "\n" && input[index] !== "\r") index += 1;
          continue;
        }
        throw syntaxError("Expected an opening delimiter after @" + entryType, index);
      }

      index += 1;
      if (entryType === "string") {
        var parsedString = parseStringEntry(input, index, opener, maxDepth);
        parsedString.definitions.forEach(function (definition) {
          macros[definition.name] = definition.pieces;
        });
        index = parsedString.index;
        continue;
      }
      if (IGNORED_ENTRY_TYPES[entryType]) {
        index = skipIgnoredEntry(input, index, opener, maxDepth);
        continue;
      }
      if (entries.length >= maxEntries) throw new RangeError("BibTeX entry count exceeds the limit");
      var parsedEntry = parseEntry(input, index, entryType, opener, maxDepth);
      entries.push(parsedEntry);
      index = parsedEntry.index;
    }

    var references = [];
    var usedKeys = Object.create(null);
    var resolutionState = {
      macros: macros,
      cache: Object.create(null),
      resolving: Object.create(null),
      stack: [],
      maxDepth: maxDepth,
      maxExpandedCharacters: maxBytes,
      expandedCharacters: 0,
    };
    entries.forEach(function (entry) {
      var reference = buildReference(entry.entryType, entry.rawKey, resolveFields(entry.fields, resolutionState));
      var key = reference.key;
      if (Object.prototype.hasOwnProperty.call(usedKeys, key)) {
        throw new Error("Duplicate citation key after normalization: " + key);
      }
      usedKeys[key] = true;
      references.push(reference);
    });
    return references;
  }

  return {
    MAX_BIBTEX_BYTES: MAX_BIBTEX_BYTES,
    MAX_BIBTEX_ENTRIES: MAX_BIBTEX_ENTRIES,
    MAX_BIBTEX_NESTING_DEPTH: MAX_NESTING_DEPTH,
    parseBibtex: parseBibtex,
  };
});
