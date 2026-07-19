import type { AstNodeDescription, MaybePromise, ReferenceInfo } from 'langium';
import { GrammarAST } from 'langium';
import type { CompletionAcceptor, CompletionContext, CompletionValueItem, NextFeature } from 'langium/lsp';
import { DefaultCompletionProvider } from 'langium/lsp';
import { CompletionItemKind } from 'vscode-languageserver';
import { isFnDecl } from './generated/ast.js';
import { renderFnDeclSignature } from './torquescript-hover-provider.js';

const VAR_PATTERN = /[$%][A-Za-z_][A-Za-z0-9_]*/g;

export class TorquescriptCompletionProvider extends DefaultCompletionProvider {

    protected override createReferenceCompletionItem(
        nodeDescription: AstNodeDescription,
        refInfo: ReferenceInfo,
        context: CompletionContext
    ): CompletionValueItem {
        const item = super.createReferenceCompletionItem(nodeDescription, refInfo, context);
        const node = nodeDescription.node;
        if (node && isFnDecl(node)) {
            // `calledMethod` means this is a `.method()` dot-call site, where a namespace
            // function's leading `%this` parameter is bound implicitly by the receiver rather
            // than typed by the caller - see renderFnDeclSignature's hideFirstParam doc.
            item.detail = renderFnDeclSignature(node, { hideFirstParam: refInfo.property === 'calledMethod' });
        }
        return item;
    }

    /**
     * VAR ($global/%local) is a plain terminal, not a cross-reference, so the default provider
     * offers nothing for it - TorqueScript variables aren't formally "declared" anywhere to
     * resolve against. Instead, propose every distinct variable name already used in the
     * document (both sigils; the editor's own prefix matching against what's typed so far
     * naturally narrows $ vs % candidates without any filtering needed here).
     */
    protected override completionFor(context: CompletionContext, next: NextFeature, acceptor: CompletionAcceptor): MaybePromise<void> {
        if (GrammarAST.isRuleCall(next.feature) && next.feature.rule.ref?.name === 'VAR') {
            const seen = new Set<string>();
            for (const match of context.document.textDocument.getText().matchAll(VAR_PATTERN)) {
                const name = match[0];
                if (seen.has(name)) {
                    continue;
                }
                seen.add(name);
                acceptor(context, { label: name, kind: CompletionItemKind.Variable });
            }
            return;
        }
        return super.completionFor(context, next, acceptor);
    }
}
