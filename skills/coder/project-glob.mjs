const MAX_PATTERN_LENGTH = 512;
const MAX_BRACE_EXPANSIONS = 256;
const MAX_COMPILED_STATES = 64 * 1024;
const MAX_MATCH_TRANSITIONS = 500_000;

function invalid(message) {
  throw new Error(`Invalid glob pattern: ${message}`);
}

function findCharacterClassEnd(pattern, start) {
  let i = start + 1;
  if (pattern[i] === '!' || pattern[i] === '^') i += 1;
  // A closing bracket is literal when it is the first class member.
  if (pattern[i] === ']') i += 1;
  for (; i < pattern.length; i += 1) {
    if (pattern[i] === '\\') { i += 1; continue; }
    if (pattern[i] === ']') return i;
  }
  return -1;
}

function findClosingBrace(pattern, start) {
  let depth = 0;
  for (let i = start; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\') { i += 1; continue; }
    if (c === '[') {
      const end = findCharacterClassEnd(pattern, i);
      if (end < 0) invalid('unbalanced character class');
      i = end;
      continue;
    }
    if (c === '{') { depth += 1; continue; }
    if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitBraceAlternatives(body) {
  const alternatives = [];
  let start = 0;
  let braceDepth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '\\') { i += 1; continue; }
    if (c === '[') {
      const end = findCharacterClassEnd(body, i);
      if (end < 0) invalid('unbalanced character class');
      i = end;
      continue;
    }
    if (c === '{') { braceDepth += 1; continue; }
    if (c === '}') { braceDepth -= 1; continue; }
    if (c === ',' && braceDepth === 0) {
      alternatives.push(body.slice(start, i));
      start = i + 1;
    }
  }
  if (alternatives.length) alternatives.push(body.slice(start));
  return alternatives;
}

function expandRange(body) {
  const numeric = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(body);
  if (numeric) {
    const start = Number(numeric[1]);
    const end = Number(numeric[2]);
    const defaultStep = start <= end ? 1 : -1;
    const suppliedStep = numeric[3] == null ? 1 : Number(numeric[3]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || !Number.isSafeInteger(suppliedStep) || suppliedStep === 0) {
      invalid(`invalid brace range {${body}}`);
    }
    const step = Math.abs(suppliedStep) * defaultStep;
    const startDigits = numeric[1].replace(/^-/, '');
    const endDigits = numeric[2].replace(/^-/, '');
    const width = (startDigits.length > 1 && startDigits.startsWith('0'))
      || (endDigits.length > 1 && endDigits.startsWith('0'))
      ? Math.max(numeric[1].length, numeric[2].length)
      : 0;
    const values = [];
    for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
      if (values.length >= MAX_BRACE_EXPANSIONS) invalid('brace range expands to too many alternatives');
      const sign = value < 0 ? '-' : '';
      const digits = String(Math.abs(value));
      const digitWidth = value < 0 ? width - 1 : width;
      values.push(sign + (width ? digits.padStart(digitWidth, '0') : digits));
    }
    return values;
  }

  const alpha = /^([^\s.])\.\.([^\s.])(?:\.\.(-?\d+))?$/u.exec(body);
  if (!alpha) return null;
  const start = alpha[1].codePointAt(0);
  const end = alpha[2].codePointAt(0);
  const defaultStep = start <= end ? 1 : -1;
  const suppliedStep = alpha[3] == null ? 1 : Number(alpha[3]);
  if (!Number.isSafeInteger(suppliedStep) || suppliedStep === 0) {
    invalid(`invalid brace range {${body}}`);
  }
  const step = Math.abs(suppliedStep) * defaultStep;
  const values = [];
  for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
    if (values.length >= MAX_BRACE_EXPANSIONS) invalid('brace range expands to too many alternatives');
    values.push(String.fromCodePoint(value));
  }
  return values;
}

function expandBraces(pattern, output = []) {
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\') { i += 1; continue; }
    if (c === '[') {
      const end = findCharacterClassEnd(pattern, i);
      if (end < 0) invalid('unbalanced character class');
      i = end;
      continue;
    }
    if (c === '}') invalid('unbalanced { }');
    if (c !== '{') continue;

    const close = findClosingBrace(pattern, i);
    if (close < 0) invalid('unbalanced { }');
    const body = pattern.slice(i + 1, close);
    let alternatives = splitBraceAlternatives(body);
    if (!alternatives.length) alternatives = expandRange(body);
    if (!alternatives?.length) invalid(`brace expression {${body}} needs alternatives or a range`);

    for (const alternative of alternatives) {
      if (output.length >= MAX_BRACE_EXPANSIONS) invalid('brace expansion has too many alternatives');
      expandBraces(pattern.slice(0, i) + alternative + pattern.slice(close + 1), output);
    }
    return output;
  }
  output.push(pattern);
  if (output.length > MAX_BRACE_EXPANSIONS) invalid('brace expansion has too many alternatives');
  return output;
}

function compileCharacterClass(pattern, start) {
  let i = start + 1;
  let negated = false;
  if (pattern[i] === '!' || pattern[i] === '^') { negated = true; i += 1; }

  const values = [];
  if (pattern[i] === ']') { values.push({ char: ']', escaped: false }); i += 1; }
  let closed = false;
  for (; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === ']' && values.length) { closed = true; break; }
    if (c === '\\') {
      if (i + 1 >= pattern.length) invalid('trailing escape in character class');
      values.push({ char: pattern[i + 1], escaped: true });
      i += 1;
      continue;
    }
    values.push({ char: c, escaped: false });
  }
  if (!closed || !values.length) invalid('unbalanced or empty character class');
  if (!negated && values.some(value => value.char === '/')) {
    invalid('character classes may not match directory separators');
  }

  const singleCharacters = [];
  const ranges = [];
  for (let index = 0; index < values.length; index += 1) {
    if (index + 2 < values.length
      && values[index + 1].char === '-' && !values[index + 1].escaped) {
      const rangeStart = values[index].char.codePointAt(0);
      const rangeEnd = values[index + 2].char.codePointAt(0);
      if (rangeStart > rangeEnd) invalid('character class range is backwards');
      const slash = '/'.codePointAt(0);
      if (!negated && rangeStart <= slash && slash <= rangeEnd) {
        invalid('character classes may not match directory separators');
      }
      ranges.push([rangeStart, rangeEnd]);
      index += 2;
    } else {
      singleCharacters.push(values[index].char);
    }
  }
  // The parser above intentionally reasons about UTF-16 code units so its
  // range/operator behavior stays compatible with the previous RE2 backend.
  // RE2 nevertheless treated adjacent surrogate literals as one class member,
  // so fold those pairs before matching Unicode code points.
  const singles = new Set();
  for (let index = 0; index < singleCharacters.length; index += 1) {
    const first = singleCharacters[index].charCodeAt(0);
    const next = singleCharacters[index + 1]?.charCodeAt(0);
    if (first >= 0xD800 && first <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
      singles.add((first - 0xD800) * 0x400 + (next - 0xDC00) + 0x10000);
      index += 1;
    } else {
      singles.add(first);
    }
  }
  return { classSpec: { negated, singles, ranges }, end: i };
}

function compileSinglePattern(pattern) {
  const states = [];
  const emit = state => {
    const index = states.length;
    states.push({ ...state, out: index + 1 });
    return index;
  };

  for (let i = 0; i < pattern.length;) {
    const c = pattern[i];
    if ('@+!*?'.includes(c) && pattern[i + 1] === '(') {
      invalid('extglob syntax is not supported; use brace alternatives such as {a,b}');
    }
    if (c === '\\') {
      if (i + 1 >= pattern.length) invalid('trailing escape');
      const literal = String.fromCodePoint(pattern.codePointAt(i + 1));
      emit({ type: 'literal', value: literal });
      i += 1 + literal.length;
      continue;
    }
    if (c === '[') {
      const compiled = compileCharacterClass(pattern, i);
      emit({ type: 'class', classSpec: compiled.classSpec });
      i = compiled.end + 1;
      continue;
    }
    if (c === '*') {
      let end = i + 1;
      while (pattern[end] === '*') end += 1;
      const count = end - i;
      const componentStart = i === 0 || pattern[i - 1] === '/';
      const componentEnd = end === pattern.length || pattern[end] === '/';
      if (count === 2 && componentStart && componentEnd) {
        if (pattern[end] === '/') {
          const start = emit({ type: 'directory_globstar' });
          const body = emit({ type: 'directory_globstar_body', start });
          states[start].body = body;
          states[start].out = body + 1;
          i = end + 1;
        } else {
          emit({ type: 'globstar' });
          i = end;
        }
      } else {
        emit({ type: 'star' });
        i = end;
      }
      continue;
    }
    if (c === '?') { emit({ type: 'any_non_separator' }); i += 1; continue; }
    if (c === '{' || c === '}') invalid('unexpanded brace expression');
    const literal = String.fromCodePoint(pattern.codePointAt(i));
    emit({ type: 'literal', value: literal });
    i += literal.length;
  }
  states.push({ type: 'accept' });
  return states;
}

function addStateWithEpsilonClosure(states, destination, initial) {
  const pending = [initial];
  while (pending.length) {
    const index = pending.pop();
    if (destination.has(index)) continue;
    destination.add(index);
    const state = states[index];
    if (state.type === 'star' || state.type === 'globstar'
      || state.type === 'directory_globstar') {
      pending.push(state.out);
    }
  }
}

function classMatches(classSpec, symbol) {
  if (symbol === '/') return false;
  const codePoint = symbol.codePointAt(0);
  let contained = classSpec.singles.has(codePoint);
  if (!contained) {
    contained = classSpec.ranges.some(([start, end]) => start <= codePoint && codePoint <= end);
  }
  return classSpec.negated ? !contained : contained;
}

function matchesCompiledPattern(states, value, work) {
  let current = new Set();
  addStateWithEpsilonClosure(states, current, 0);

  for (const symbol of value) {
    work.transitions += current.size;
    if (work.transitions > MAX_MATCH_TRANSITIONS) {
      invalid('matching work limit exceeded; simplify the pattern');
    }
    const next = new Set();
    for (const index of current) {
      const state = states[index];
      switch (state.type) {
        case 'literal':
          if (symbol === state.value) addStateWithEpsilonClosure(states, next, state.out);
          break;
        case 'class':
          if (classMatches(state.classSpec, symbol)) {
            addStateWithEpsilonClosure(states, next, state.out);
          }
          break;
        case 'any_non_separator':
          if (symbol !== '/') addStateWithEpsilonClosure(states, next, state.out);
          break;
        case 'star':
          if (symbol !== '/') addStateWithEpsilonClosure(states, next, index);
          break;
        case 'globstar':
          addStateWithEpsilonClosure(states, next, index);
          break;
        case 'directory_globstar':
          if (symbol !== '/') addStateWithEpsilonClosure(states, next, state.body);
          break;
        case 'directory_globstar_body':
          if (symbol === '/') addStateWithEpsilonClosure(states, next, state.start);
          else addStateWithEpsilonClosure(states, next, index);
          break;
        default:
          break;
      }
    }
    current = next;
    if (!current.size) return false;
  }

  return current.has(states.length - 1);
}

export function compileProjectGlob(pattern) {
  if (typeof pattern !== 'string') throw new Error('pattern must be a string.');
  if (!pattern.length) throw new Error('pattern must not be empty.');
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`pattern too long (max ${MAX_PATTERN_LENGTH} characters).`);
  }

  try {
    // Different brace choices can collapse to the same concrete pattern (for
    // example, concatenated {a,aa} groups). Matching duplicates independently
    // wastes the entire NFA budget without changing the result.
    const expanded = [...new Set(expandBraces(pattern))];
    const alternatives = expanded.map(compileSinglePattern);
    const stateCount = alternatives.reduce((total, states) => total + states.length, 0);
    if (stateCount > MAX_COMPILED_STATES) invalid('compiled pattern is too large');
    return {
      test(value) {
        if (typeof value !== 'string') return false;
        const work = { transitions: 0 };
        return alternatives.some(states => matchesCompiledPattern(states, value, work));
      },
    };
  } catch (error) {
    if (error?.message?.startsWith('Invalid glob pattern:')) throw error;
    throw new Error(`Invalid glob pattern ${JSON.stringify(pattern)}: ${error.message}`);
  }
}
