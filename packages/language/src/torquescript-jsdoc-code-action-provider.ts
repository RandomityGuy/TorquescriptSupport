import type { AstNode, LangiumDocument } from 'langium';
import { AstUtils, CstUtils } from 'langium';
import type { CodeActionProvider } from 'langium/lsp';
import type { CodeAction, CodeActionParams, Command, Position } from 'vscode-languageserver';
import { CodeActionKind, TextEdit } from 'vscode-languageserver';
import type { FnDecl, VarExpr } from './generated/ast.js';
import { isFnDecl, isVarExpr } from './generated/ast.js';
import type { TorquescriptServices } from './torquescript-module.js';
import { unwrapExpr } from './torquescript-expr-utils.js';
import { TorquescriptTypeInference } from './torquescript-type-inference.js';

/**
 * Nearest enclosing `%var = ...;` this cursor sits in that is itself a statement (not a
 * sub-expression buried inside another expression, e.g. not the `%y` inside `foo(%y = 1)`).
 * A statement-level assignment's VarExpr is never the direct child of the statement list - the
 * precedence-chain wrapper nodes (TernaryExpr -> OrExpr -> ... -> BitwiseExpr, see
 * torquescript-expr-utils.ts) sit above it even when no operator is used - so this walks up to
 * the actual statement-list element first, then confirms `unwrapExpr` of *that* lands back on the
 * same VarExpr candidate found on the way up.
 */
function findAssignmentStatement(node: AstNode | undefined): VarExpr | undefined {
    let current = node;
    let candidate: VarExpr | undefined;
    while (current) {
        if (!candidate && isVarExpr(current) && current.value) {
            candidate = current;
        }
        if (current.$containerProperty === 'statements' || current.$containerProperty === 'decls') {
            return candidate && unwrapExpr(current) === candidate ? candidate : undefined;
        }
        current = current.$container;
    }
    return undefined;
}

function getLineIndent(document: LangiumDocument, offset: number): { position: Position; indent: string } {
    const text = document.textDocument.getText();
    const lineStartOffset = text.lastIndexOf('\n', offset - 1) + 1;
    const indentMatch = /^[ \t]*/.exec(text.slice(lineStartOffset));
    return {
        position: document.textDocument.positionAt(lineStartOffset),
        indent: indentMatch ? indentMatch[0] : ''
    };
}

function insertAboveLine(document: LangiumDocument, offset: number, bodyLines: string[]): TextEdit {
    const { position, indent } = getLineIndent(document, offset);
    const text = bodyLines.length === 1
        ? `${indent}/** ${bodyLines[0]} */\n`
        : `${indent}/**\n${bodyLines.map(l => `${indent} * ${l}\n`).join('')}${indent} */\n`;
    return TextEdit.insert(position, text);
}

/**
 * Offers two quick "add JSDoc" actions: a `@type` annotation on a `%var = ...;` assignment
 * (pre-filled with our own best-effort inferred type when we have one, a placeholder otherwise),
 * and a full `@param`/`@returns` template on a function declaration that doesn't have a doc
 * comment yet. These are the same `@type {Type}`/`@param {Type} %name`/`@returns {Type}` tags
 * (real JSDoc brace-typed syntax) TorquescriptTypeInference already reads - see that file for the
 * annotation format and inference philosophy.
 */
export class TorquescriptJsdocCodeActionProvider implements CodeActionProvider {

    private readonly typeInference: TorquescriptTypeInference;
    private readonly commentProvider: TorquescriptServices['documentation']['CommentProvider'];

    constructor(services: TorquescriptServices) {
        this.typeInference = new TorquescriptTypeInference(services);
        this.commentProvider = services.documentation.CommentProvider;
    }

    getCodeActions(document: LangiumDocument, params: CodeActionParams): Array<Command | CodeAction> | undefined {
        const rootCst = document.parseResult.value.$cstNode;
        if (!rootCst) {
            return undefined;
        }
        const offset = document.textDocument.offsetAt(params.range.start);
        const leaf = CstUtils.findLeafNodeAtOffset(rootCst, offset);
        if (!leaf) {
            return undefined;
        }

        const actions: CodeAction[] = [];

        const fnDecl = AstUtils.getContainerOfType(leaf.astNode, isFnDecl);
        if (fnDecl && !this.commentProvider.getComment(fnDecl)) {
            actions.push(this.buildFunctionJsdocAction(document, fnDecl));
        }

        const assignment = findAssignmentStatement(leaf.astNode);
        if (assignment && !this.commentProvider.getComment(assignment)) {
            actions.push(this.buildTypeAnnotationAction(document, assignment));
        }

        return actions.length > 0 ? actions : undefined;
    }

    private buildFunctionJsdocAction(document: LangiumDocument, fnDecl: FnDecl): CodeAction {
        const paramLines = (fnDecl.params?.var ?? []).map(name => `@param {Type} ${name}`);
        const bodyLines = [...paramLines, '@returns {Type}'];
        const offset = fnDecl.$cstNode?.offset ?? 0;
        return {
            title: 'Add JSDoc for this function',
            kind: CodeActionKind.RefactorRewrite,
            edit: {
                changes: {
                    [document.textDocument.uri]: [insertAboveLine(document, offset, bodyLines)]
                }
            }
        };
    }

    private buildTypeAnnotationAction(document: LangiumDocument, assignment: VarExpr): CodeAction {
        const inferred = assignment.value ? this.typeInference.inferType(assignment.value) : undefined;
        const typeName = inferred?.classDecl?.name ?? inferred?.extraNamespaces[0] ?? 'ClassName';
        const offset = assignment.$cstNode?.offset ?? 0;
        return {
            title: inferred ? `Add @type {${typeName}} annotation` : 'Add @type annotation',
            kind: CodeActionKind.RefactorRewrite,
            edit: {
                changes: {
                    [document.textDocument.uri]: [insertAboveLine(document, offset, [`@type {${typeName}}`])]
                }
            }
        };
    }
}
