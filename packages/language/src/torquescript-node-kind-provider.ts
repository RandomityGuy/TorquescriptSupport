import type { AstNode, AstNodeDescription } from 'langium';
import { CompletionItemKind, SymbolKind } from 'vscode-languageserver';
import { DefaultNodeKindProvider } from 'langium/lsp';

function typeOf(node: AstNode | AstNodeDescription): string {
    return 'type' in node ? node.type : node.$type;
}

/**
 * The default NodeKindProvider gives every node the same generic "Reference" icon in the
 * completion list. This gives functions/classes/methods/fields distinct, conventional icons
 * (the purple "f" box for functions, etc.) so the completion dialog is actually informative.
 */
export class TorquescriptNodeKindProvider extends DefaultNodeKindProvider {

    override getCompletionItemKind(node: AstNode | AstNodeDescription): CompletionItemKind {
        switch (typeOf(node)) {
            case 'FnDecl':
                return CompletionItemKind.Function;
            case 'ConsoleClassDecl':
                return CompletionItemKind.Class;
            case 'ConsoleMethodDecl':
                return CompletionItemKind.Method;
            case 'ConsoleFieldDecl':
                return CompletionItemKind.Field;
            default:
                return super.getCompletionItemKind(node);
        }
    }

    override getSymbolKind(node: AstNode | AstNodeDescription): SymbolKind {
        switch (typeOf(node)) {
            case 'FnDecl':
                return SymbolKind.Function;
            case 'ConsoleClassDecl':
                return SymbolKind.Class;
            case 'ConsoleMethodDecl':
                return SymbolKind.Method;
            case 'ConsoleFieldDecl':
                return SymbolKind.Field;
            case 'PackageDecl':
                return SymbolKind.Namespace;
            case 'DatablockStmt':
                return SymbolKind.Struct;
            case 'ObjectDecl':
                return SymbolKind.Object;
            default:
                return super.getSymbolKind(node);
        }
    }
}
