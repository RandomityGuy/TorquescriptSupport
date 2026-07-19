import type { Diagnostic } from 'vscode-languageserver-types';
import type { LangiumDocument, ValidationOptions } from 'langium';
import { DefaultDocumentValidator, DocumentValidator } from 'langium';

/**
 * TorqueScript is dynamic - functions may be defined by files exec()'d at runtime that the LSP
 * can't see, and a game's console API dump may simply be incomplete. Treating an unresolved
 * function/class reference as a hard error would be noisy and often wrong, so this downgrades
 * linking-error diagnostics to warnings (the default document validator hardcodes 'error').
 */
export class TorquescriptDocumentValidator extends DefaultDocumentValidator {

    protected override processLinkingErrors(document: LangiumDocument, diagnostics: Diagnostic[], _options: ValidationOptions): void {
        for (const reference of document.references) {
            const linkingError = reference.error;
            if (linkingError) {
                // `Parent::methodName(...)` is TorqueScript's mechanism for calling the base
                // implementation of the current package-overridden function (like `super`). It
                // never resolves to a real declaration named literally "Parent" - that's
                // resolved dynamically at runtime against whatever package is beneath the
                // current one - so it's not a real unresolved reference and shouldn't warn.
                if (/^parent::/i.test(linkingError.info.reference.$refText)) {
                    continue;
                }
                // TorqueScript datablocks/objects freely accept dynamic fields beyond whatever
                // the engine's known/registered fields are - an unresolved `slot` just means
                // "not one of the known static fields", not a mistake, so never warn on it.
                if (linkingError.info.property === 'slot') {
                    continue;
                }
                // `.methodName()`/`.fieldName` receiver-type inference is a best-effort heuristic
                // (see TorquescriptTypeInference) - an unresolved calledMethod/field here just
                // means the receiver's type couldn't be confidently guessed, not a real mistake.
                // The one exception (an explicit `@type` override where the method truly isn't
                // found) is handled separately as its own dedicated validation check, not here.
                if (linkingError.info.property === 'calledMethod' || linkingError.info.property === 'field') {
                    continue;
                }
                diagnostics.push(this.toDiagnostic('warning', linkingError.message, {
                    node: linkingError.info.container,
                    range: reference.$refNode?.range,
                    property: linkingError.info.property,
                    index: linkingError.info.index,
                    data: {
                        code: DocumentValidator.LinkingError,
                        containerType: linkingError.info.container.$type,
                        property: linkingError.info.property,
                        refText: linkingError.info.reference.$refText
                    }
                }));
            }
        }
    }
}
