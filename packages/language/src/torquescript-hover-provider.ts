import type { AstNode, DocumentationProvider, LangiumDocument, MaybePromise } from 'langium';
import { CstUtils } from 'langium';
import { AstNodeHoverProvider } from 'langium/lsp';
import type { Hover, HoverParams } from 'vscode-languageserver';
import { builtinDocumentation, builtinFunctionSignatures } from './console-api/build-console-api-document.js';
import type { ConsoleMethodDecl, FnDecl } from './generated/ast.js';
import type { Expr } from './generated/ast.js';
import { isConsoleClassDecl, isConsoleFieldDecl, isConsoleMethodDecl, isFnDecl, isVarExpr } from './generated/ast.js';
import { TorquescriptTypeInference } from './torquescript-type-inference.js';
import type { TorquescriptServices } from './torquescript-module.js';

/**
 * Renders `name(%a, %b)` for a user-defined function, or the dump's raw signature for a built-in.
 *
 * `hideFirstParam` is for `.method()` dot-call sites: a namespace function
 * (`function ClassName::method(%this, %a, %b)`) only takes `%this` implicitly, bound to whatever
 * is left of the `.` - the caller only ever writes the remaining arguments (`%obj.method(a, b)`),
 * so showing `%this` in that context would describe an argument you never actually type. Direct
 * `ClassName::method(...)` calls (no receiver) are unaffected - there, the caller must pass
 * everything explicitly, `%this` included, so the full parameter list is what's shown.
 */
export function renderFnDeclSignature(node: FnDecl, options?: { hideFirstParam?: boolean }): string {
    const compositeName = node.classname ? `${node.classname}::${node.name}` : node.name;
    const builtinSignature = builtinFunctionSignatures.get(node);
    if (builtinSignature !== undefined) {
        return node.classname ? `${node.classname}::${builtinSignature}` : builtinSignature;
    }
    const allParams = node.params?.var ?? [];
    const params = options?.hideFirstParam ? allParams.slice(1) : allParams;
    return `${compositeName}(${params.join(', ')})`;
}

export class TorquescriptHoverProvider extends AstNodeHoverProvider {

    private readonly typeInference: TorquescriptTypeInference;
    private readonly documentationProvider: DocumentationProvider;

    constructor(services: TorquescriptServices) {
        super(services);
        this.typeInference = new TorquescriptTypeInference(services);
        this.documentationProvider = services.documentation.DocumentationProvider;
    }

    /**
     * `%var` usages and bareword object references (`PlayMissionGui.onWake();`, i.e. a name used
     * directly rather than through a `%var`) aren't cross-references or named declarations, so the
     * default reference-resolution-based hover mechanism (`getAstNodeHoverContent`, below) never
     * even looks at them. This adds a fallback: when hovering one of those and the default
     * mechanism had nothing, show its TorquescriptTypeInference-guessed type, if any.
     */
    override async getHoverContent(document: LangiumDocument, params: HoverParams): Promise<Hover | undefined> {
        const defaultHover = await super.getHoverContent(document, params);
        if (defaultHover) {
            return defaultHover;
        }
        return this.getInferredTypeHover(document, params);
    }

    private getInferredTypeHover(document: LangiumDocument, params: HoverParams): Hover | undefined {
        const rootCst = document.parseResult.value.$cstNode;
        if (!rootCst) {
            return undefined;
        }
        const offset = document.textDocument.offsetAt(params.position);
        const leaf = CstUtils.findDeclarationNodeAtOffset(rootCst, offset, this.grammarConfig.nameRegexp);
        const node = leaf?.astNode;
        if (!node) {
            return undefined;
        }

        let displayName: string;
        let typeSource: AstNode;
        if (isVarExpr(node)) {
            displayName = node.var;
            typeSource = node;
        } else if ('bareword' in node && (node as Partial<Expr>).bareword) {
            displayName = (node as Partial<Expr>).bareword!;
            typeSource = node;
        } else {
            return undefined;
        }

        const inferred = this.typeInference.inferType(typeSource);
        const typeNames = [
            ...(inferred?.classDecl ? [inferred.classDecl.name] : []),
            // An object's own name is always included as a namespace source for method
            // resolution purposes (see inferFromObjectDecl), but showing it back as a "type" of
            // itself (`PlayMissionGui: GuiControl / PlayMissionGui`) is just noise in hover text.
            ...(inferred?.extraNamespaces.filter(name => name.toLowerCase() !== displayName.toLowerCase()) ?? [])
        ];
        if (typeNames.length === 0) {
            return undefined;
        }

        const confidence = inferred?.source === 'explicit' ? ' _(explicit)_' : ' _(inferred)_';
        return {
            contents: {
                kind: 'markdown',
                value: `\`${displayName}\`: ${typeNames.join(' / ')}\n${confidence}`
            }
        };
    }

    protected override getAstNodeHoverContent(node: AstNode): MaybePromise<string | undefined> {
        if (isFnDecl(node)) {
            const lines = [`\`function ${renderFnDeclSignature(node)}\n\``];
            // User functions get their own `/** */` comment rendered as real JSDoc; built-ins have
            // no CST for CommentProvider to look at, so they fall back to whatever doc-comment text
            // was captured from the console dump (see builtinDocumentation's doc comment).
            const documentation = this.documentationProvider.getDocumentation(node) ?? this.renderBuiltinDocumentation(node);
            if (documentation) {
                lines.push('', documentation);
            }
            return lines.join('\n');
        }
        if (isConsoleClassDecl(node)) {
            const lines: string[] = [];
            const heading = node.parentClass
                ? `class ${node.name} : ${node.parentClass.$refText}`
                : `class ${node.name}`;
            lines.push('`', heading, '`');
            if (node.methods.length > 0) {
                lines.push('', '**Methods**', node.methods.map(m => `- ${m.signature ?? m.name}`).join('\n'));
            }
            if (node.fields.length > 0) {
                lines.push('', '**Fields**', node.fields.map(f => `- ${f.fieldType ? `${f.fieldType} ` : ''}${f.name}`).join('\n'));
            }
            return lines.join('\n');
        }
        if (isConsoleFieldDecl(node)) {
            return `\`\n${node.fieldType ? `${node.fieldType} ` : ''}${node.name}\n\``;
        }
        if (isConsoleMethodDecl(node)) {
            const lines = [`\`\n${node.signature ?? node.name}\n\``];
            const documentation = this.renderBuiltinDocumentation(node);
            if (documentation) {
                lines.push('', documentation);
            }
            return lines.join('\n');
        }
        return undefined;
    }

    /** Lightly formats the console dump's own doc-comment text (plain Doxygen-ish prose, not real JSDoc) - just bolds `@tag` lines so they read like the rest of the hover output. */
    private renderBuiltinDocumentation(node: FnDecl | ConsoleMethodDecl): string | undefined {
        const documentation = builtinDocumentation.get(node);
        return documentation?.replace(/^@(\w+)/gm, '**@$1**');
    }
}
