/**
 * Heuristic parsers for the pseudo-C++ "console dump" text files that TorqueScript-based
 * engines can export (e.g. via dumpConsoleFunctions()/dumpConsoleClasses()). These are not
 * arbitrary C++ - they're a narrow, machine-generated subset - so a small regex/scanner-based
 * parser is enough; this is not a general C++ parser.
 */

export interface ParsedConsoleFunction {
    name: string;
    signature: string;
    documentation?: string;
}

export interface ParsedConsoleMethod {
    name: string;
    signature: string;
    documentation?: string;
}

export interface ParsedConsoleField {
    name: string;
    fieldType: string;
}

export interface ParsedConsoleClass {
    name: string;
    parentName?: string;
    methods: ParsedConsoleMethod[];
    fields: ParsedConsoleField[];
}

/**
 * Same length as the input (comment characters replaced with spaces, newlines preserved) so
 * offsets keep lining up between the stripped and original text - needed to recover a method's
 * original `/*! ... *\/` doc-comment text after using the stripped text to find safe match
 * boundaries (class-body brace depth, field lines) without false-positives from comment content
 * (e.g. a stray `{`/`}` or `;` mentioned in a description).
 */
function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n\r]*/g, match => match.replace(/[^\n]/g, ' '));
}

// The doc-comment group is optional and must sit immediately before `virtual` (only whitespace
// between) - real dumps document a function with a `/*! ... */` block directly above it, e.g.
// `/*! @param channel_id ID of channel to fetch volume from. */\nvirtual int alxGetChannelVolume(int channel_id) {}`.
const METHOD_PATTERN = /(?:\/\*!([\s\S]*?)\*\/\s*)?virtual\s+[\w:*&<>]+\s+(\w+)\s*\(([^)]*)\)\s*\{\s*\}/g;
// No doc-capture group - used only to strip method declarations out of a class body before field
// extraction, where the doc-comment text (if any) has already been blanked by stripComments.
const METHOD_CODE_ONLY_PATTERN = /virtual\s+[\w:*&<>]+\s+\w+\s*\([^)]*\)\s*\{\s*\}/g;

/** Strips `/*! *\/` delimiters, trims each line, drops Doxygen `@{`/`@}` grouping markers - `undefined` if nothing meaningful is left. */
function cleanDocComment(raw: string | undefined): string | undefined {
    if (!raw) {
        return undefined;
    }
    const cleaned = raw
        .split('\n')
        .map(line => line.trim().replace(/^\*+\s?/, ''))
        .join('\n')
        .replace(/@\{|@\}/g, '')
        .trim();
    return cleaned.length > 0 ? cleaned : undefined;
}

export function parseConsoleFunctions(text: string): ParsedConsoleFunction[] {
    const functions: ParsedConsoleFunction[] = [];
    for (const match of text.matchAll(METHOD_PATTERN)) {
        const name = match[2];
        const params = match[3].trim();
        functions.push({ name, signature: `${name}(${params})`, documentation: cleanDocComment(match[1]) });
    }
    return functions;
}

const CLASS_HEADER_PATTERN = /class\s+(\w+)\s*(?::\s*public\s+(\w+))?\s*\{/g;
// Deliberately not anchored at the start: the first field in a class body has no leading `;` to
// separate it from the class header/access-specifier/stripped-method text before it, so the
// segment being matched can have arbitrary junk before the actual `TYPE NAME` pair. Anchoring
// only at the end still avoids matching mid-segment noise.
const FIELD_LINE_PATTERN = /([A-Za-z_][\w:<>]*)\s+([A-Za-z_]\w*)$/;

function findClassBody(cleanedText: string, openBraceIndex: number): { start: number; end: number; resumeIndex: number } {
    let depth = 1;
    let i = openBraceIndex + 1;
    for (; i < cleanedText.length && depth > 0; i++) {
        if (cleanedText[i] === '{') {
            depth++;
        } else if (cleanedText[i] === '}') {
            depth--;
        }
    }
    return { start: openBraceIndex + 1, end: i - 1, resumeIndex: i };
}

function parseFields(cleanedBody: string): ParsedConsoleField[] {
    const withoutMethods = cleanedBody.replace(METHOD_CODE_ONLY_PATTERN, ' ');
    const fields: ParsedConsoleField[] = [];
    for (const rawStatement of withoutMethods.split(';')) {
        const statement = rawStatement.trim();
        if (!statement) {
            continue;
        }
        const match = FIELD_LINE_PATTERN.exec(statement);
        if (match) {
            fields.push({ fieldType: match[1], name: match[2] });
        }
    }
    return fields;
}

export function parseConsoleClasses(text: string): ParsedConsoleClass[] {
    const cleaned = stripComments(text);
    const classes: ParsedConsoleClass[] = [];
    CLASS_HEADER_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CLASS_HEADER_PATTERN.exec(cleaned)) !== null) {
        const name = match[1];
        const parentName = match[2];
        const openBraceIndex = match.index + match[0].length - 1;
        const { start, end, resumeIndex } = findClassBody(cleaned, openBraceIndex);

        // Original (comments intact) for method-doc extraction; cleaned (comments blanked) for
        // field extraction - both slices line up since stripComments preserves text length.
        const originalBody = text.slice(start, end);
        const cleanedBody = cleaned.slice(start, end);

        const methods: ParsedConsoleMethod[] = [];
        for (const methodMatch of originalBody.matchAll(METHOD_PATTERN)) {
            const methodName = methodMatch[2];
            const params = methodMatch[3].trim();
            methods.push({ name: methodName, signature: `${methodName}(${params})`, documentation: cleanDocComment(methodMatch[1]) });
        }

        classes.push({ name, parentName, methods, fields: parseFields(cleanedBody) });
        CLASS_HEADER_PATTERN.lastIndex = resumeIndex;
    }
    return classes;
}
