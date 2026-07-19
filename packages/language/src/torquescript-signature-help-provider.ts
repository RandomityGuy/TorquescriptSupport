import type { AstNode, Cancellation, LangiumDocument } from 'langium';
import { CstUtils } from 'langium';
import { AbstractSignatureHelpProvider } from 'langium/lsp';
import type { ParameterInformation, SignatureHelp, SignatureHelpParams } from 'vscode-languageserver';
import { builtinFunctionSignatures } from './console-api/build-console-api-document.js';
import type { ConsoleMethodDecl, Expr, FnDecl } from './generated/ast.js';
import { isConsoleMethodDecl, isFnDecl, isPrimaryExprSuffix } from './generated/ast.js';
import { renderFnDeclSignature } from './torquescript-hover-provider.js';

/**
 * Splits a signature's parenthesized parameter text on top-level commas (not inside nested
 * `()`/`[]`, the latter being the dump's own optional-parameter bracket notation, e.g.
 * `echo(text [, ... ])`). Best-effort: the console dumps' signature text is often incomplete or
 * inconsistently formatted (missing types, no params listed for functions that do take them,
 * etc.), so this only ever *assists* - if nothing sensible can be split out, the caller falls
 * back to showing the raw signature text with no per-parameter highlighting rather than guessing.
 */
function parseSignatureParams(signatureText: string): string[] {
    const openIdx = signatureText.indexOf('(');
    if (openIdx === -1) {
        return [];
    }
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < signatureText.length; i++) {
        if (signatureText[i] === '(') {
            depth++;
        } else if (signatureText[i] === ')') {
            depth--;
            if (depth === 0) {
                closeIdx = i;
                break;
            }
        }
    }
    if (closeIdx === -1) {
        return [];
    }
    const inner = signatureText.slice(openIdx + 1, closeIdx);
    if (!inner.trim()) {
        return [];
    }
    const params: string[] = [];
    let bracketDepth = 0;
    let current = '';
    for (const ch of inner) {
        if (ch === '[' || ch === '(') {
            bracketDepth++;
        } else if (ch === ']' || ch === ')') {
            bracketDepth--;
        }
        if (ch === ',' && bracketDepth === 0) {
            params.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) {
        params.push(current.trim());
    }
    return params.filter(p => p.length > 0);
}

/** First `(` at or after `fromOffset`, skipping only whitespace - `undefined` if not found immediately. */
function findOpenParenOffset(text: string, fromOffset: number): number | undefined {
    for (let i = fromOffset; i < text.length; i++) {
        if (text[i] === '(') {
            return i;
        }
        if (!/\s/.test(text[i])) {
            return undefined;
        }
    }
    return undefined;
}

/** Counts top-level commas between an open paren and the cursor; `undefined` if the cursor is no longer inside this call (a paren closed before reaching it). */
function computeActiveParameter(text: string, openParenOffset: number, cursorOffset: number): number | undefined {
    let depth = 0;
    let paramIndex = 0;
    const end = Math.min(cursorOffset, text.length);
    for (let i = openParenOffset + 1; i < end; i++) {
        const ch = text[i];
        if (ch === '(' || ch === '[' || ch === '{') {
            depth++;
        } else if (ch === ')' || ch === ']' || ch === '}') {
            if (depth === 0) {
                return undefined;
            }
            depth--;
        } else if (ch === ',' && depth === 0) {
            paramIndex++;
        }
    }
    return paramIndex;
}

export class TorquescriptSignatureHelpProvider extends AbstractSignatureHelpProvider {

    override provideSignatureHelp(
        document: LangiumDocument,
        params: SignatureHelpParams,
        _cancelToken?: Cancellation.CancellationToken
    ): SignatureHelp | undefined {
        const rootCst = document.parseResult.value.$cstNode;
        if (!rootCst) {
            return undefined;
        }
        const cursorOffset = document.textDocument.offsetAt(params.position);
        const leaf = CstUtils.findLeafNodeAtOffset(rootCst, cursorOffset);
        if (!leaf) {
            return undefined;
        }

        let current: AstNode | undefined = leaf.astNode;
        while (current) {
            if (isPrimaryExprSuffix(current) && current.calledMethod?.ref && current.calledMethod.$refNode) {
                return this.buildSignatureHelp(current.calledMethod.ref, current.calledMethod.$refNode.end, document, cursorOffset, true);
            }
            const expr = current as Partial<Expr>;
            if (expr.calledFunction?.ref && expr.calledFunction.$refNode) {
                return this.buildSignatureHelp(expr.calledFunction.ref, expr.calledFunction.$refNode.end, document, cursorOffset, false);
            }
            current = current.$container;
        }
        return undefined;
    }

    /** Unused - `provideSignatureHelp` is fully overridden above since finding the enclosing call and counting the active parameter both need the raw document text, not just the AST node the default flow would resolve. */
    protected override getSignatureFromElement(): undefined {
        return undefined;
    }

    private buildSignatureHelp(
        target: FnDecl | ConsoleMethodDecl,
        nameEndOffset: number,
        document: LangiumDocument,
        cursorOffset: number,
        isMethodCall: boolean
    ): SignatureHelp | undefined {
        const text = document.textDocument.getText();
        const openParenOffset = findOpenParenOffset(text, nameEndOffset);
        if (openParenOffset === undefined) {
            return undefined;
        }
        const activeParameter = computeActiveParameter(text, openParenOffset, cursorOffset);
        if (activeParameter === undefined) {
            return undefined;
        }

        const { label, paramLabels } = this.describeTarget(target, isMethodCall);
        const parameters: ParameterInformation[] = paramLabels.map(l => ({ label: l }));

        return {
            signatures: [{
                label,
                parameters: parameters.length > 0 ? parameters : undefined
            }],
            activeSignature: 0,
            activeParameter: parameters.length > 0 ? Math.min(activeParameter, parameters.length - 1) : undefined
        };
    }

    /**
     * `isMethodCall` (i.e. this came from a `.method()` dot-call suffix) strips a user-defined
     * namespace function's leading `%this` parameter - it's bound implicitly to the receiver, not
     * typed by the caller, so it shouldn't appear as an argument to fill in. Direct
     * `ClassName::method(...)` calls and built-in console methods (whose dump signatures never
     * include an implicit receiver in the first place) are unaffected.
     */
    private describeTarget(target: FnDecl | ConsoleMethodDecl, isMethodCall: boolean): { label: string; paramLabels: string[] } {
        if (isFnDecl(target)) {
            const builtinSignature = builtinFunctionSignatures.get(target);
            if (builtinSignature !== undefined) {
                return { label: builtinSignature, paramLabels: parseSignatureParams(builtinSignature) };
            }
            const allParams = target.params?.var ?? [];
            const paramLabels = isMethodCall ? allParams.slice(1) : allParams;
            return { label: renderFnDeclSignature(target, { hideFirstParam: isMethodCall }), paramLabels };
        }
        if (isConsoleMethodDecl(target)) {
            const label = target.signature ?? `${target.name}()`;
            return { label, paramLabels: parseSignatureParams(label) };
        }
        return { label: '', paramLabels: [] };
    }
}
