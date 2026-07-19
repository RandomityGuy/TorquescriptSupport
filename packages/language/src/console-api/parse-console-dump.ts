/**
 * Heuristic parsers for the pseudo-C++ "console dump" text files that TorqueScript-based
 * engines can export (e.g. via dumpConsoleFunctions()/dumpConsoleClasses()). These are not
 * arbitrary C++ - they're a narrow, machine-generated subset - so a small regex/scanner-based
 * parser is enough; this is not a general C++ parser.
 */

export interface ParsedConsoleFunction {
    name: string;
    signature: string;
}

export interface ParsedConsoleMethod {
    name: string;
    signature: string;
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

function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n\r]*/g, ' ');
}

const METHOD_PATTERN = /virtual\s+[\w:*&<>]+\s+(\w+)\s*\(([^)]*)\)\s*\{\s*\}/g;

export function parseConsoleFunctions(text: string): ParsedConsoleFunction[] {
    const cleaned = stripComments(text);
    const functions: ParsedConsoleFunction[] = [];
    for (const match of cleaned.matchAll(METHOD_PATTERN)) {
        const name = match[1];
        const params = match[2].trim();
        functions.push({ name, signature: `${name}(${params})` });
    }
    return functions;
}

const CLASS_HEADER_PATTERN = /class\s+(\w+)\s*(?::\s*public\s+(\w+))?\s*\{/g;
// Deliberately not anchored at the start: the first field in a class body has no leading `;` to
// separate it from the class header/access-specifier/stripped-method text before it, so the
// segment being matched can have arbitrary junk before the actual `TYPE NAME` pair. Anchoring
// only at the end still avoids matching mid-segment noise.
const FIELD_LINE_PATTERN = /([A-Za-z_][\w:<>]*)\s+([A-Za-z_]\w*)$/;

function findClassBody(text: string, openBraceIndex: number): { body: string; endIndex: number } {
    let depth = 1;
    let i = openBraceIndex + 1;
    for (; i < text.length && depth > 0; i++) {
        if (text[i] === '{') {
            depth++;
        } else if (text[i] === '}') {
            depth--;
        }
    }
    return { body: text.slice(openBraceIndex + 1, i - 1), endIndex: i };
}

function parseFields(body: string): ParsedConsoleField[] {
    const withoutMethods = body.replace(METHOD_PATTERN, ' ');
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
        const { body, endIndex } = findClassBody(cleaned, openBraceIndex);

        const methods: ParsedConsoleMethod[] = [];
        for (const methodMatch of body.matchAll(METHOD_PATTERN)) {
            const methodName = methodMatch[1];
            const params = methodMatch[2].trim();
            methods.push({ name: methodName, signature: `${methodName}(${params})` });
        }

        classes.push({ name, parentName, methods, fields: parseFields(body) });
        CLASS_HEADER_PATTERN.lastIndex = endIndex;
    }
    return classes;
}
