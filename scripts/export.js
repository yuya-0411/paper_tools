(function (root) {
  "use strict";

  var PaperTools = (root.PaperTools = root.PaperTools || {});
  var ASSET_DATA_KEYS = {
    binary: true,
    blob: true,
    bytes: true,
    content: true,
    data: true,
    file: true,
  };

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function firstValue() {
    for (var index = 0; index < arguments.length; index += 1) {
      var value = arguments[index];
      if (value !== undefined && value !== null && value !== "") {
        return value;
      }
    }
    return "";
  }

  function text(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  function manuscriptOf(project) {
    return isObject(project) && isObject(project.manuscript) ? project.manuscript : {};
  }

  function researchOf(project) {
    return isObject(project) && isObject(project.research) ? project.research : {};
  }

  function titleOf(project) {
    var manuscript = manuscriptOf(project);
    var research = researchOf(project);
    return text(firstValue(project && project.title, manuscript.title, research.title, "Untitled paper"));
  }

  function abstractOf(project) {
    var manuscript = manuscriptOf(project);
    var research = researchOf(project);
    return text(
      firstValue(
        project && project.abstract,
        manuscript.abstract,
        research.abstract,
        research.summary,
        research.objective,
      ),
    );
  }

  function sectionsOf(project) {
    var manuscript = manuscriptOf(project);
    return asArray(manuscript.sections).length
      ? asArray(manuscript.sections)
      : asArray(project && project.sections);
  }

  function authorsOf(project) {
    var manuscript = manuscriptOf(project);
    return asArray(project && project.authors).length
      ? asArray(project.authors)
      : asArray(manuscript.authors);
  }

  function referencesOf(project) {
    var manuscript = manuscriptOf(project);
    return asArray(project && project.references).length
      ? asArray(project.references)
      : asArray(manuscript.references);
  }

  function assetsOf(project) {
    return asArray(project && project.assets);
  }

  function keywordsOf(project) {
    var manuscript = manuscriptOf(project);
    var research = researchOf(project);
    var value = firstValue(project && project.keywords, manuscript.keywords, research.keywords);
    if (Array.isArray(value)) {
      return value.map(text).filter(Boolean);
    }
    if (typeof value === "string") {
      return value
        .split(/[,;、，]/)
        .map(function (item) {
          return item.trim();
        })
        .filter(Boolean);
    }
    return [];
  }

  function personName(person) {
    if (!isObject(person)) {
      return text(person);
    }
    var explicit = firstValue(person.name, person.displayName, person.literal);
    if (explicit) {
      return text(explicit);
    }
    return [firstValue(person.given, person.givenName, person.firstName), firstValue(person.family, person.familyName, person.lastName)]
      .map(text)
      .filter(Boolean)
      .join(" ");
  }

  function escapeTypst(value) {
    var source = text(value);
    var replacements = {
      "\\": "\\\\",
      "#": "\\#",
      "$": "\\$",
      "@": "\\@",
      "[": "\\[",
      "]": "\\]",
      "{": "\\{",
      "}": "\\}",
      "*": "\\*",
      "_": "\\_",
      "=": "\\=",
      "<": "\\<",
      ">": "\\>",
      "`": "\\`",
    };
    return source
      .replace(/\r\n?/g, "\n")
      .replace(/[\\#$@\[\]{}*_=<>`]/g, function (character) {
        return replacements[character];
      })
      .replace(/\/\//g, "\\/\\/")
      .replace(/^(\s*)([+\-/])(?=\s)/gm, "$1\\$2")
      .replace(/^(\s*)(\d+)\.(?=\s)/gm, "$1$2\\.");
  }

  function escapeTypstProse(value) {
    var source = text(value);
    var pattern = /(^|[^A-Za-z0-9_@])@([A-Za-z0-9_](?:[A-Za-z0-9_.:-]*[A-Za-z0-9_])?)/g;
    var output = "";
    var cursor = 0;
    var match;
    while ((match = pattern.exec(source)) !== null) {
      var citationStart = match.index + match[1].length;
      output += escapeTypst(source.slice(cursor, citationStart));
      output += "@" + match[2];
      cursor = match.index + match[0].length;
    }
    return output + escapeTypst(source.slice(cursor));
  }

  function renderSectionTypst(section, level) {
    var heading = text(firstValue(section && section.title, section && section.heading, section && section.name, "Section"));
    var content = text(firstValue(section && section.content, section && section.body, section && section.text));
    var output = [Array(Math.max(1, Math.min(6, level)) + 1).join("=") + " " + escapeTypst(heading)];
    if (content) {
      output.push("", escapeTypstProse(content));
    }
    var children = asArray(section && firstValue(section.sections, section.children, section.subsections));
    children.forEach(function (child) {
      output.push("", renderSectionTypst(child, level + 1));
    });
    return output.join("\n");
  }

  function renderTypst(project) {
    project = isObject(project) ? project : {};
    if (typeof project.typstSource === "string" && project.typstSource.trim()) {
      return project.typstSource;
    }
    var languageValue = text(firstValue(project.language, manuscriptOf(project).language)).toLowerCase();
    var language = languageValue.indexOf("ja") === 0 ? "ja" : "en";
    var englishRegion = project.englishVariant === "british" ? "GB" : "US";
    var abstractLabel = language === "ja" ? "概要" : "Abstract";
    var keywordsLabel = language === "ja" ? "キーワード" : "Keywords";
    var output = [
      "// Generated by paper_tools. Edit this file freely after export.",
      '#set text(lang: "' + language + '"' + (language === "en" ? ', region: "' + englishRegion + '"' : "") + ")",
      "#set par(justify: true)",
      "",
      "#align(center)[",
      "  #text(size: 18pt, weight: \"bold\")[" + escapeTypst(titleOf(project)) + "]",
    ];

    var authors = authorsOf(project);
    if (authors.length) {
      output.push("  #v(0.8em)");
      authors.forEach(function (author, index) {
        var details = [personName(author) + (isObject(author) && author.corresponding ? " *" : "")];
        if (isObject(author) && author.affiliation) {
          details.push(text(author.affiliation));
        }
        if (isObject(author) && author.orcid) {
          details.push("ORCID: " + text(author.orcid));
        }
        if (isObject(author) && author.corresponding && author.email) {
          details.push(text(author.email));
        }
        var line = details.filter(Boolean).join(" — ");
        output.push("  #text[" + escapeTypst(line) + "]");
        if (index < authors.length - 1) {
          output.push("  #linebreak()");
        }
      });
    }
    output.push("]");

    var sections = preparedSections(project);
    var template = PaperTools.templateMap && PaperTools.templateMap[project.templateId];
    var twoColumn = template && template.layout === "two-column";
    var abstract = abstractOf(project);
    var hasAbstractSection = sections.some(function (section) {
      var id = sectionIdentifier(section);
      return id === "abstract" || id === "summary";
    });
    if (abstract && !hasAbstractSection) {
      output.push("", "= " + abstractLabel, "", escapeTypstProse(abstract));
    }
    var keywords = keywordsOf(project);
    if (keywords.length) {
      output.push(
        "",
        "#strong[" + keywordsLabel + ":] " + escapeTypst(keywords.join(", ")),
      );
    }
    var abstractSections = twoColumn ? sections.filter(function (section) {
      var id = sectionIdentifier(section);
      return id === "abstract" || id === "summary";
    }) : [];
    var bodySections = twoColumn ? sections.filter(function (section) {
      var id = sectionIdentifier(section);
      return id !== "abstract" && id !== "summary";
    }) : sections;
    var assetRecords = exportAssetRecords(project);
    function appendSection(section) {
      output.push("", renderSectionTypst(section, 1));
      assetRecords
        .filter(function (record) {
          return record.metadata.target === sectionIdentifier(section) && ["figure", "table"].indexOf(record.metadata.role) !== -1 && /\.(?:png|jpe?g|svg|pdf)$/i.test(record.filename);
        })
        .forEach(function (record) {
          var caption = text(firstValue(record.metadata.caption, record.metadata.displayName, record.metadata.name, record.filename));
          if (record.metadata.origin === "cited" && record.metadata.source) caption += " — " + text(record.metadata.source);
          output.push("", "#figure(image(" + JSON.stringify(record.path) + ", width: 100%), caption: [" + escapeTypstProse(caption) + "]" + (record.metadata.role === "table" ? ", kind: table" : "") + ")");
        });
    }
    abstractSections.forEach(function (section) {
      appendSection(section);
    });
    if (twoColumn) output.push("", "#columns(2, gutter: 1.2em)[");
    bodySections.forEach(function (section) {
      appendSection(section);
    });
    if (referencesOf(project).length) {
      output.push("", '#bibliography("references.yml", full: true)');
    }
    if (twoColumn) output.push("]");
    return output.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
  }

  function referenceKey(reference, index, used) {
    var raw = firstValue(reference && reference.key, reference && reference.id, "ref" + (index + 1));
    var candidate = typeof PaperTools.normalizeCitationKey === "function"
      ? PaperTools.normalizeCitationKey(raw)
      : text(raw).trim().replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/^[.:-]+|[.:-]+$/g, "");
    if (!candidate) {
      candidate = "ref" + (index + 1);
    }
    if (used[candidate]) {
      throw new Error("Duplicate citation key: " + candidate);
    }
    used[candidate] = true;
    return candidate;
  }

  function referenceAuthors(reference) {
    var value = reference && reference.authors;
    var authors = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(/\s*;\s*|\s+and\s+|\s*、\s*/i).filter(Boolean)
        : [];
    return authors
      .map(personName)
      .filter(Boolean);
  }

  function sectionIdentifier(section) {
    return text(firstValue(section && section.id, section && section.sectionId, section && section.section_id))
      .trim()
      .toLowerCase();
  }

  function preparedSections(project) {
    return sectionsOf(project).filter(function (section) {
      var id = sectionIdentifier(section);
      // References are rendered from the current structured records. Never
      // re-export stale prose from a previously generated References section.
      return id !== "references" && id !== "bibliography";
    });
  }

  function yamlString(value) {
    return JSON.stringify(text(value));
  }

  function normalizedReferenceType(value) {
    var source = text(value).toLowerCase();
    var aliases = {
      phdthesis: "thesis",
      mastersthesis: "thesis",
      thesis: "thesis",
      techreport: "report",
      report: "report",
      inbook: "chapter",
      incollection: "chapter",
      chapter: "chapter",
      "conference-paper": "article",
      conference: "article",
      inproceedings: "article",
      "journal-article": "article",
      webpage: "web",
      website: "web",
    };
    var normalized = aliases[source] || source.replace(/[^a-z-]/g, "");
    return normalized || "misc";
  }

  function renderReferencesYaml(project) {
    var references = referencesOf(isObject(project) ? project : {});
    if (!references.length) {
      return "# No references.\n";
    }
    var used = Object.create(null);
    var lines = [];
    references.forEach(function (reference, index) {
      reference = isObject(reference) ? reference : { title: text(reference) };
      var key = referenceKey(reference, index, used);
      var rawType = text(reference.type).toLowerCase();
      var normalizedType = normalizedReferenceType(rawType);
      lines.push(yamlString(key) + ":");
      lines.push("  type: " + yamlString(normalizedType));
      lines.push("  title: " + yamlString(firstValue(reference.title, "Untitled reference")));
      var authors = referenceAuthors(reference);
      if (authors.length) {
        lines.push("  author:");
        authors.forEach(function (author) {
          lines.push("    - " + yamlString(author));
        });
      }
      var rawDate = text(firstValue(reference.year, reference.date)).trim();
      var year = typeof PaperTools.normalizeReferenceDate === "function"
        ? PaperTools.normalizeReferenceDate(rawDate)
        : (/^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/.test(rawDate) ? rawDate : "");
      if (year) {
        lines.push("  date: " + year);
      }
      var venue = firstValue(reference.venue, reference.journal, reference.booktitle, reference.publisher);
      if (venue) {
        if (normalizedType === "book") {
          lines.push("  publisher: " + yamlString(venue));
        } else if (normalizedType === "thesis" || normalizedType === "report") {
          lines.push("  organization: " + yamlString(venue));
        } else {
          var parentType = normalizedType === "chapter"
            ? "book"
            : /^(inproceedings|conference|conference-paper)$/.test(rawType)
              ? "proceedings"
              : normalizedType === "article"
                ? "periodical"
                : "";
          lines.push("  parent:");
          if (parentType) lines.push("    type: " + yamlString(parentType));
          lines.push("    title: " + yamlString(venue));
        }
      }
      if (reference.doi) {
        lines.push("  serial-number:");
        lines.push("    doi: " + yamlString(reference.doi));
      }
      if (reference.url) {
        lines.push("  url: " + yamlString(reference.url));
      }
      if (reference.note) {
        lines.push("  note: " + yamlString(reference.note));
      }
      lines.push("");
    });
    return lines.join("\n").replace(/\n+$/, "\n");
  }

  function escapeBibtex(value) {
    var replacements = {
      "\\": "\\textbackslash{}",
      "{": "\\{",
      "}": "\\}",
      "%": "\\%",
      "#": "\\#",
      "&": "\\&",
      "_": "\\_",
      "$": "\\$",
    };
    return text(value)
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[\\{}%#&_$]/g, function (character) {
        return replacements[character];
      });
  }

  function bibtexType(value) {
    var source = text(value).toLowerCase();
    if (/conference|proceedings/.test(source)) {
      return "inproceedings";
    }
    if (/book/.test(source)) {
      return "book";
    }
    if (/thesis/.test(source)) {
      return "phdthesis";
    }
    if (/article|journal/.test(source)) {
      return "article";
    }
    return "misc";
  }

  function renderBibtex(project) {
    var references = referencesOf(isObject(project) ? project : {});
    var used = Object.create(null);
    return (
      references
        .map(function (reference, index) {
          reference = isObject(reference) ? reference : { title: text(reference) };
          var type = bibtexType(reference.type);
          var fields = [];
          var authors = referenceAuthors(reference);
          if (authors.length) {
            fields.push(["author", authors.join(" and ")]);
          }
          fields.push(["title", firstValue(reference.title, "Untitled reference")]);
          var referenceYear = typeof PaperTools.normalizeReferenceDate === "function"
            ? PaperTools.normalizeReferenceDate(firstValue(reference.year, reference.date))
            : text(firstValue(reference.year, reference.date)).trim();
          if (referenceYear) {
            fields.push(["year", referenceYear.slice(0, 4)]);
          }
          if (reference.venue) {
            fields.push([type === "inproceedings" ? "booktitle" : "journal", reference.venue]);
          }
          ["doi", "url", "note"].forEach(function (name) {
            if (reference[name]) {
              fields.push([name, reference[name]]);
            }
          });
          var body = fields
            .map(function (field) {
              return "  " + field[0] + " = {" + escapeBibtex(field[1]) + "}";
            })
            .join(",\n");
          return "@" + type + "{" + referenceKey(reference, index, used) + ",\n" + body + "\n}";
        })
        .join("\n\n") + (references.length ? "\n" : "")
    );
  }

  function isBinary(value) {
    if (value === null || value === undefined) {
      return false;
    }
    if (typeof root.Blob === "function" && value instanceof root.Blob) {
      return true;
    }
    if (typeof root.ArrayBuffer === "function") {
      return value instanceof root.ArrayBuffer || root.ArrayBuffer.isView(value);
    }
    return false;
  }

  function cloneForJson(value, ancestors, assetContext) {
    if (value === undefined || typeof value === "function" || typeof value === "symbol") {
      return undefined;
    }
    if (typeof value === "bigint") {
      return String(value);
    }
    if (isBinary(value)) {
      return undefined;
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    if (ancestors.indexOf(value) !== -1) {
      throw new TypeError("Cannot serialize a project containing circular references");
    }
    ancestors.push(value);
    var result;
    if (Array.isArray(value)) {
      result = value.map(function (item) {
        var cloned = cloneForJson(item, ancestors, assetContext);
        return cloned === undefined ? null : cloned;
      });
    } else {
      result = {};
      Object.keys(value).forEach(function (key) {
        if (assetContext && ASSET_DATA_KEYS[key]) {
          return;
        }
        var cloned = cloneForJson(value[key], ancestors, key === "assets");
        if (cloned !== undefined) {
          result[key] = cloned;
        }
      });
    }
    ancestors.pop();
    return result;
  }

  function serializeProject(project) {
    var clean = cloneForJson(isObject(project) ? project : {}, [], false);
    var payload = JSON.stringify(clean, null, 2) + "\n";
    var maxBytes = Math.max(1, Number(PaperTools.MAX_BACKUP_BYTES) || 100 * 1024 * 1024);
    var byteLength = typeof root.TextEncoder === "function"
      ? new root.TextEncoder().encode(payload).byteLength
      : unescape(encodeURIComponent(payload)).length;
    if (byteLength > maxBytes) {
      throw new RangeError("バックアップ対象が100 MBを超えています．履歴または添付を整理してください．");
    }
    return payload;
  }

  function decodeBase64(value) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var cleaned = value.replace(/\s+/g, "").replace(/=+$/, "");
    if (/[^A-Za-z0-9+/]/.test(cleaned) || cleaned.length % 4 === 1) {
      throw new Error("Invalid base64 asset data");
    }
    var bytes = [];
    var buffer = 0;
    var bits = 0;
    for (var index = 0; index < cleaned.length; index += 1) {
      buffer = (buffer << 6) | alphabet.indexOf(cleaned.charAt(index));
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >> bits) & 0xff);
      }
    }
    return new Uint8Array(bytes);
  }

  function decodeDataUrl(value) {
    var comma = value.indexOf(",");
    if (comma === -1) {
      throw new Error("Invalid data URL in asset");
    }
    var metadata = value.slice(5, comma);
    var payload = value.slice(comma + 1);
    if (/;base64(?:;|$)/i.test(metadata)) {
      return decodeBase64(payload);
    }
    var bytes = [];
    for (var index = 0; index < payload.length; index += 1) {
      if (payload.charAt(index) === "%" && /^[0-9A-Fa-f]{2}$/.test(payload.slice(index + 1, index + 3))) {
        bytes.push(parseInt(payload.slice(index + 1, index + 3), 16));
        index += 2;
      } else {
        var code = payload.charCodeAt(index);
        if (code > 0x7f) {
          return new root.TextEncoder().encode(decodeURIComponent(payload));
        }
        bytes.push(code);
      }
    }
    return new Uint8Array(bytes);
  }

  function assetPayload(asset) {
    if (isBinary(asset) || typeof asset === "string") {
      return asset;
    }
    if (!isObject(asset)) {
      return undefined;
    }
    var candidates = [asset.data, asset.blob, asset.file, asset.bytes, asset.binary, asset.content];
    for (var index = 0; index < candidates.length; index += 1) {
      var candidate = candidates[index];
      if (candidate !== undefined && candidate !== null) {
        if (typeof candidate === "string" && candidate.indexOf("data:") === 0) {
          return decodeDataUrl(candidate);
        }
        return candidate;
      }
    }
    return undefined;
  }

  function extensionForType(type) {
    var extensions = {
      "application/json": ".json",
      "application/pdf": ".pdf",
      "image/gif": ".gif",
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/svg+xml": ".svg",
      "text/csv": ".csv",
      "text/plain": ".txt",
    };
    return extensions[text(type).toLowerCase()] || ".bin";
  }

  function safeFilename(value, fallback) {
    var source = text(value).replace(/\\/g, "/");
    source = source.slice(source.lastIndexOf("/") + 1);
    source = source
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim();
    if (!source) {
      source = fallback;
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(source)) {
      source = "_" + source;
    }
    var dot = source.lastIndexOf(".");
    var extension = dot > 0 && /^\.[A-Za-z0-9]{1,16}$/.test(source.slice(dot))
      ? source.slice(dot)
      : "";
    var stem = extension ? source.slice(0, -extension.length) : source;
    return stem.slice(0, Math.max(1, 180 - extension.length)).replace(/[. ]+$/g, "") + extension;
  }

  function uniqueFilename(filename, used) {
    var candidate = filename;
    var dot = filename.lastIndexOf(".");
    var stem = dot > 0 ? filename.slice(0, dot) : filename;
    var extension = dot > 0 ? filename.slice(dot) : "";
    var suffix = 2;
    while (used[candidate.toLowerCase()]) {
      candidate = stem + "-" + suffix + extension;
      suffix += 1;
    }
    used[candidate.toLowerCase()] = true;
    return candidate;
  }

  function exportAssetRecords(project) {
    var usedNames = Object.create(null);
    var usedIds = Object.create(null);
    return assetsOf(project).map(function (asset, index) {
      var metadata = isObject(asset) ? asset : {};
      var fallback = "asset-" + (index + 1) + extensionForType(metadata.type);
      var filename = uniqueFilename(
        safeFilename(firstValue(metadata.name, metadata.filename, metadata.path), fallback),
        usedNames,
      );
      var assetId = text(firstValue(metadata.id, "asset-" + (index + 1)));
      if (usedIds[assetId]) throw new Error("添付ファイルIDが重複しています：" + assetId);
      usedIds[assetId] = true;
      return { metadata: metadata, filename: filename, path: "assets/" + filename, id: assetId };
    });
  }

  function collectArchiveAssets(project) {
    var files = [];
    var manifestAssets = [];
    var missing = [];
    exportAssetRecords(project).forEach(function (record, index) {
      var asset = assetsOf(project)[index];
      var payload = assetPayload(asset);
      var metadata = record.metadata;
      if (payload === undefined) {
        missing.push(text(firstValue(metadata.name, metadata.filename, "asset-" + (index + 1))));
        return;
      }
      var payloadSize = typeof payload.size === "number"
        ? payload.size
        : typeof payload.byteLength === "number"
          ? payload.byteLength
          : typeof payload === "string" && typeof root.TextEncoder === "function"
            ? new root.TextEncoder().encode(payload).byteLength
            : null;
      files.push({ name: record.path, data: payload, lastModified: metadata.lastModified });
      manifestAssets.push({
        id: record.id,
        name: record.filename,
        path: record.path,
        type: text(metadata.type),
        size: payloadSize,
      });
    });
    if (missing.length) {
      throw new Error("添付ファイル本体が見つかりません：" + missing.join("，") + "．元ファイルを再追加してください．");
    }
    return { files: files, manifestAssets: manifestAssets };
  }

  async function createProjectArchive(project) {
    if (typeof PaperTools.createZip !== "function") {
      throw new Error("PaperTools.createZip must be loaded before creating an archive");
    }
    project = isObject(project) ? project : {};
    var files = [
      { name: "project.json", data: serializeProject(project) },
      { name: "paper.typ", data: renderTypst(project) },
      { name: "references.yml", data: renderReferencesYaml(project) },
      { name: "references.bib", data: renderBibtex(project) },
    ];
    var collected = collectArchiveAssets(project);
    files = files.concat(collected.files);
    files.push({
      name: "manifest.json",
      data:
        JSON.stringify(
          {
            format: "paper-tools-project-archive",
            version: 1,
            exportedAt: new Date().toISOString(),
            projectFile: "project.json",
            manuscriptFile: "paper.typ",
            assets: collected.manifestAssets,
          },
          null,
          2,
        ) + "\n",
    });
    return await PaperTools.createZip(files);
  }

  async function createTypstBundle(project) {
    if (typeof PaperTools.createZip !== "function") {
      throw new Error("PaperTools.createZip must be loaded before creating a bundle");
    }
    project = isObject(project) ? project : {};
    var collected = collectArchiveAssets(project);
    var files = [{ name: "main.typ", data: renderTypst(project) }];
    if (referencesOf(project).length) {
      files.push({ name: "references.yml", data: renderReferencesYaml(project) });
    }
    files = files.concat(collected.files);
    files.push({
      name: "manifest.json",
      data: JSON.stringify({
        format: "paper-tools-typst-bundle",
        version: 1,
        manuscriptFile: "main.typ",
        assets: collected.manifestAssets,
      }, null, 2) + "\n",
    });
    return await PaperTools.createZip(files);
  }

  function downloadBlob(blob, name) {
    if (!root.document || !root.URL || typeof root.URL.createObjectURL !== "function") {
      throw new Error("Blob downloads require a browser document");
    }
    if (typeof root.Blob !== "function") {
      throw new Error("This browser does not support Blob downloads");
    }
    var downloadable = blob instanceof root.Blob ? blob : new root.Blob([blob]);
    var filename = safeFilename(name, "download.bin");
    var url = root.URL.createObjectURL(downloadable);
    var anchor = root.document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    (root.document.body || root.document.documentElement).appendChild(anchor);
    anchor.click();
    anchor.remove();
    root.setTimeout(function () {
      root.URL.revokeObjectURL(url);
    }, 0);
    return filename;
  }

  function escapeHtml(value) {
    return text(value).replace(/[&<>"']/g, function (character) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[character];
    });
  }

  function inlinePrintHtml(value, citationNumbers) {
    var source = text(value);
    if (!citationNumbers) return escapeHtml(source);
    var pattern = /(^|[^A-Za-z0-9_@])@([A-Za-z0-9_](?:[A-Za-z0-9_.:-]*[A-Za-z0-9_])?)/g;
    var output = "";
    var cursor = 0;
    var match;
    while ((match = pattern.exec(source)) !== null) {
      var citationStart = match.index + match[1].length;
      output += escapeHtml(source.slice(cursor, citationStart));
      output += citationNumbers[match[2]]
        ? '<span class="citation">[' + citationNumbers[match[2]] + "]</span>"
        : escapeHtml("@" + match[2]);
      cursor = match.index + match[0].length;
    }
    return output + escapeHtml(source.slice(cursor));
  }

  function htmlParagraphs(value, citationNumbers) {
    var normalized = text(value).replace(/\r\n?/g, "\n").trim();
    if (!normalized) {
      return "";
    }
    return normalized
      .split(/\n{2,}/)
      .map(function (paragraph) {
        return "<p>" + inlinePrintHtml(paragraph, citationNumbers).replace(/\n/g, "<br>") + "</p>";
      })
      .join("\n");
  }

  function renderSectionHtml(section, level, citationNumbers) {
    var safeLevel = Math.max(2, Math.min(6, level));
    var heading = firstValue(section && section.title, section && section.heading, section && section.name, "Section");
    var content = firstValue(section && section.content, section && section.body, section && section.text);
    var output = ["<section>", "<h" + safeLevel + ">" + escapeHtml(heading) + "</h" + safeLevel + ">"];
    if (content) {
      output.push(htmlParagraphs(content, citationNumbers));
    }
    asArray(section && firstValue(section.sections, section.children, section.subsections)).forEach(
      function (child) {
        output.push(renderSectionHtml(child, safeLevel + 1, citationNumbers));
      },
    );
    output.push("</section>");
    return output.join("\n");
  }

  function referenceText(reference) {
    reference = isObject(reference) ? reference : { title: text(reference) };
    var parts = [];
    var authors = referenceAuthors(reference);
    if (authors.length) {
      parts.push(authors.join(", "));
    }
    if (reference.year) {
      parts.push("(" + text(reference.year) + ")");
    }
    if (reference.title) {
      parts.push(text(reference.title));
    }
    if (reference.venue) {
      parts.push(text(reference.venue));
    }
    if (reference.doi) {
      parts.push("DOI: " + text(reference.doi));
    }
    if (reference.url) {
      parts.push(text(reference.url));
    }
    if (reference.note) {
      parts.push(text(reference.note));
    }
    return parts.join(". ");
  }

  function projectToPrintHtml(project, assetSources) {
    project = isObject(project) ? project : {};
    var languageValue = text(firstValue(project.language, manuscriptOf(project).language)).toLowerCase();
    var language = languageValue.indexOf("ja") === 0 ? "ja" : "en";
    var htmlLanguage = language === "en" ? (project.englishVariant === "british" ? "en-GB" : "en-US") : "ja";
    var title = titleOf(project);
    var abstract = abstractOf(project);
    var keywords = keywordsOf(project);
    var authorMarkup = authorsOf(project)
      .map(function (author) {
        var name = personName(author);
        var details = [];
        if (isObject(author) && author.affiliation) {
          details.push(text(author.affiliation));
        }
        if (isObject(author) && author.email) {
          details.push(text(author.email));
        }
        if (isObject(author) && author.orcid) {
          details.push("ORCID: " + text(author.orcid));
        }
        return (
          '<div class="author"><strong>' +
          escapeHtml(name + (isObject(author) && author.corresponding ? " *" : "")) +
          "</strong>" +
          (details.length ? "<small>" + escapeHtml(details.join(" · ")) + "</small>" : "") +
          "</div>"
        );
      })
      .join("\n");
    var sections = preparedSections(project);
    var references = referencesOf(project);
    var citationNumbers = Object.create(null);
    references.forEach(function (reference, index) {
      var key = text(reference && reference.key).trim();
      if (key && !citationNumbers[key]) citationNumbers[key] = index + 1;
    });
    var sourceForAsset = function (id) {
      if (assetSources instanceof Map) return assetSources.get(id) || "";
      return isObject(assetSources) ? assetSources[id] || "" : "";
    };
    var printTemplate = PaperTools.templateMap && PaperTools.templateMap[project.templateId];
    var twoColumn = printTemplate && printTemplate.layout === "two-column";
    var renderSectionWithAssets = function (section) {
        var markup = renderSectionHtml(section, 2, citationNumbers);
        var figures = assetsOf(project)
          .filter(function (asset) {
            return asset && ["figure", "table"].indexOf(asset.role) !== -1 && asset.target === sectionIdentifier(section) && sourceForAsset(asset.id);
          })
          .map(function (asset) {
            var caption = text(firstValue(asset.caption, asset.displayName, asset.name));
            if (asset.origin === "cited" && asset.source) caption += " — " + text(asset.source);
            return '<figure><img src="' + escapeHtml(sourceForAsset(asset.id)) + '" alt="' + escapeHtml(text(firstValue(asset.caption, asset.displayName, asset.name))) + '"><figcaption>' + inlinePrintHtml(caption, citationNumbers) + "</figcaption></figure>";
          })
          .join("\n");
        return markup + figures;
      };
    var abstractSections = twoColumn ? sections.filter(function (section) {
      var id = sectionIdentifier(section);
      return id === "abstract" || id === "summary";
    }) : [];
    var bodySections = twoColumn ? sections.filter(function (section) {
      var id = sectionIdentifier(section);
      return id !== "abstract" && id !== "summary";
    }) : sections;
    var abstractSectionMarkup = abstractSections.map(renderSectionWithAssets).join("\n");
    var sectionMarkup = bodySections
      .map(renderSectionWithAssets)
      .join("\n");
    var hasAbstractSection = sections.some(function (section) {
      var id = sectionIdentifier(section);
      return id === "abstract" || id === "summary";
    });
    var referenceMarkup = references.length
      ? "<section><h2>" +
        (language === "ja" ? "参考文献" : "References") +
        "</h2><ol>" +
        references
          .map(function (reference) {
            return "<li>" + escapeHtml(referenceText(reference)) + "</li>";
          })
          .join("") +
        "</ol></section>"
      : "";

    return (
      "<!doctype html>\n" +
      '<html lang="' +
      htmlLanguage +
      '"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      "<title>" +
      escapeHtml(title) +
      "</title><style>" +
      "@page{size:A4;margin:22mm 20mm}*{box-sizing:border-box}body{max-width:170mm;margin:0 auto;color:#17211f;font:11pt/1.7 Georgia,'Yu Mincho','Hiragino Mincho ProN',serif}" +
      "h1{text-align:center;font-size:20pt;line-height:1.35;margin:0 0 1rem}h2{font-size:15pt;margin:2rem 0 .6rem;border-bottom:1px solid #adb9b5}h3,h4,h5,h6{margin:1.4rem 0 .5rem}" +
      ".authors{text-align:center;margin-bottom:1.6rem}.author{margin:.25rem}.author small{display:block;color:#465652}p{text-align:justify;margin:.5rem 0}.abstract{margin:1.5rem 0;padding:1rem 1.2rem;background:#f3f7f5}.keywords{font-size:9.5pt}.citation{white-space:nowrap}li{margin:.4rem 0}" +
      ".two-column .paper-sections{column-count:2;column-gap:8mm}.two-column .paper-sections h2{column-span:none}figure{break-inside:avoid;margin:1rem 0}figure img{display:block;max-width:100%;max-height:110mm;margin:0 auto}figcaption{font-size:9pt;line-height:1.45;margin-top:.4rem;text-align:center}" +
      "section{break-inside:auto}h2,h3,h4,h5,h6{break-after:avoid}p,li{orphans:3;widows:3}@media print{body{max-width:none}.no-print{display:none}}" +
      "</style></head><body" + (twoColumn ? ' class="two-column"' : "") + "><article><header><h1>" +
      escapeHtml(title) +
      '</h1><div class="authors">' +
      authorMarkup +
      "</div></header>" +
      (abstract && !hasAbstractSection
        ? '<section class="abstract"><h2>' +
          (language === "ja" ? "概要" : "Abstract") +
          "</h2>" +
          htmlParagraphs(abstract, citationNumbers) +
          "</section>"
        : "") +
      (keywords.length
        ? '<p class="keywords"><strong>' +
          (language === "ja" ? "キーワード" : "Keywords") +
          ":</strong> " +
          escapeHtml(keywords.join(", ")) +
          "</p>"
        : "") +
      abstractSectionMarkup +
      '<div class="paper-sections">' +
      sectionMarkup +
      referenceMarkup +
      "</div>" +
      "</article></body></html>"
    );
  }

  PaperTools.escapeTypst = escapeTypst;
  PaperTools.escapeTypstProse = escapeTypstProse;
  PaperTools.renderTypst = renderTypst;
  PaperTools.renderReferencesYaml = renderReferencesYaml;
  PaperTools.renderBibtex = renderBibtex;
  PaperTools.serializeProject = serializeProject;
  PaperTools.createProjectArchive = createProjectArchive;
  PaperTools.createTypstBundle = createTypstBundle;
  PaperTools.downloadBlob = downloadBlob;
  PaperTools.projectToPrintHtml = projectToPrintHtml;
})(typeof globalThis !== "undefined" ? globalThis : this);
