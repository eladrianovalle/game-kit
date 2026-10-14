// Finds the numbers written out in a piece of TypeScript source, for the test
// that keeps bare numbers out of the game's rules. Comments and the text of
// strings are skipped; code inside a template string's `${...}` is not.

export interface NumericLiteral {
  /** The number as written: `3`, `0.5`, `0xff`, `10n`. */
  text: string;
  /** The line it is on, counting from 1. */
  line: number;
}

const NUMBER = /(?<![\w$.])(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)n?/g;

/**
 * The source with every comment and every string's text blanked out, line
 * breaks kept so line numbers still hold.
 */
export function withoutCommentsAndStrings(source: string): string {
  let result = '';
  /** What surrounds the current character, innermost last. A `{` inside a template's code is tracked so its `}` is not taken for the end. */
  const context: ('template' | 'templateCode' | 'braces')[] = [];
  const blank = (text: string): string => text.replace(/[^\n]/g, ' ');
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    const pair = source.slice(index, index + 2);
    const inTemplateText = context[context.length - 1] === 'template';

    if (inTemplateText) {
      if (character === '\\') {
        result += '  ';
        index += 2;
      } else if (character === '`') {
        context.pop();
        result += character;
        index += 1;
      } else if (pair === '${') {
        context.push('templateCode');
        result += pair;
        index += 2;
      } else {
        result += blank(character);
        index += 1;
      }
      continue;
    }

    if (pair === '//') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      result += blank(source.slice(index, stop));
      index = stop;
    } else if (pair === '/*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      result += blank(source.slice(index, stop));
      index = stop;
    } else if (character === "'" || character === '"') {
      let stop = index + 1;
      while (stop < source.length && source[stop] !== character && source[stop] !== '\n') {
        stop += source[stop] === '\\' ? 2 : 1;
      }
      result += character + blank(source.slice(index + 1, stop)) + character;
      index = stop + 1;
    } else if (character === '`') {
      context.push('template');
      result += character;
      index += 1;
    } else {
      if (character === '{' && context.length > 0) {
        context.push('braces');
      } else if (character === '}' && context.length > 0) {
        context.pop();
      }
      result += character;
      index += 1;
    }
  }
  return result;
}

/** Every number written out in the source's code. */
export function listNumericLiterals(source: string): NumericLiteral[] {
  const found: NumericLiteral[] = [];
  withoutCommentsAndStrings(source)
    .split('\n')
    .forEach((lineText, lineIndex) => {
      for (const match of lineText.matchAll(NUMBER)) {
        found.push({ text: match[0], line: lineIndex + 1 });
      }
    });
  return found;
}

/** The value of a number as written, whatever its base, separators or `n`. */
export function valueOfLiteral(text: string): number {
  return Number(text.replaceAll('_', '').replace(/n$/, ''));
}
