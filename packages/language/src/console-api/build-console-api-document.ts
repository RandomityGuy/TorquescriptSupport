import type { LangiumDocument, LangiumDocumentFactory, Reference, URI } from 'langium';
import type { ConsoleApiModel, ConsoleClassDecl, ConsoleFieldDecl, ConsoleMethodDecl, FnDecl } from '../generated/ast.js';
import type { TorquescriptServices } from '../torquescript-module.js';
import type { ParsedConsoleClass, ParsedConsoleFunction } from './parse-console-dump.js';

/**
 * Built-in functions have no real `params=VarList` (there's no TorqueScript source to parse
 * `%paramName` tokens from) - only the free-text signature captured from the dump, e.g.
 * `echo(text [, ... ])`. Keyed by node rather than stored as an ad-hoc AST property so the
 * FnDecl type stays exactly what the grammar declares.
 */
export const builtinFunctionSignatures = new WeakMap<FnDecl, string>();

/**
 * The `/*! ... *\/` doc-comment block the engine's dump places immediately above a built-in
 * function/method, if any - captured by parse-console-dump.ts. Synthetic nodes have no CST, so
 * there's nothing for Langium's own CommentProvider/DocumentationProvider to find; this is the
 * hover provider's source of truth for built-in documentation instead.
 */
export const builtinDocumentation = new WeakMap<FnDecl | ConsoleMethodDecl, string>();

/**
 * Builds an in-memory ConsoleApiModel AST from parsed console-dump data and wraps it as a real
 * LangiumDocument via `fromModel`, so its FnDecl/ConsoleClassDecl nodes become genuinely
 * resolvable cross-reference targets (indexed, linkable) exactly like nodes from a parsed file.
 *
 * $container/$containerProperty/$containerIndex are set by hand on every node since `fromModel`
 * does not derive them - AstNodeLocator needs them to compute a node's path within the document.
 * Reference-valued properties (parentClass) must be built via `Linker.buildReference` rather than
 * a plain `{ $refText }` object, since only that shape is recognized by the linker's resolution pass.
 */
export function buildConsoleApiDocument(
    functions: ParsedConsoleFunction[],
    classes: ParsedConsoleClass[],
    uri: URI,
    documentFactory: LangiumDocumentFactory,
    languageServices: TorquescriptServices
): LangiumDocument<ConsoleApiModel> {
    const linker = languageServices.references.Linker;

    const model = {
        $type: 'ConsoleApiModel',
        classes: [],
        functions: []
    } as unknown as ConsoleApiModel;

    model.functions = functions.map((fn, index): FnDecl => {
        const fnNode: FnDecl = {
            $type: 'FnDecl',
            $container: model,
            $containerProperty: 'functions',
            $containerIndex: index,
            name: fn.name,
            statements: []
        };
        builtinFunctionSignatures.set(fnNode, fn.signature);
        if (fn.documentation) {
            builtinDocumentation.set(fnNode, fn.documentation);
        }
        return fnNode;
    });

    model.classes = classes.map((cls, index): ConsoleClassDecl => {
        const classNode = {
            $type: 'ConsoleClassDecl',
            $container: model,
            $containerProperty: 'classes',
            $containerIndex: index,
            name: cls.name,
            methods: [],
            fields: []
        } as unknown as ConsoleClassDecl;

        if (cls.parentName) {
            classNode.parentClass = linker.buildReference(classNode, 'parentClass', undefined, cls.parentName) as Reference<ConsoleClassDecl>;
        }

        classNode.methods = cls.methods.map((m, methodIndex): ConsoleMethodDecl => {
            const methodNode: ConsoleMethodDecl = {
                $type: 'ConsoleMethodDecl',
                $container: classNode,
                $containerProperty: 'methods',
                $containerIndex: methodIndex,
                name: m.name,
                signature: m.signature
            };
            if (m.documentation) {
                builtinDocumentation.set(methodNode, m.documentation);
            }
            return methodNode;
        });

        classNode.fields = cls.fields.map((f, fieldIndex): ConsoleFieldDecl => ({
            $type: 'ConsoleFieldDecl',
            $container: classNode,
            $containerProperty: 'fields',
            $containerIndex: fieldIndex,
            name: f.name,
            fieldType: f.fieldType
        }));

        return classNode;
    });

    return documentFactory.fromModel(model, uri);
}
