import type { LangiumDocument } from 'langium';
import { DefaultDocumentBuilder } from 'langium';

/**
 * Reference properties whose unresolved state is *expected and permanent* by design - dynamic
 * datablock/object fields (`slot`), and best-effort method/field-via-receiver-type resolution
 * (`calledMethod`, `field` on PrimaryExprSuffix). These are never going to "become resolved by
 * some other file changing" the way a genuinely missing function or class might.
 */
const ALWAYS_SILENT_PROPERTIES = new Set(['slot', 'calledMethod', 'field']);

/**
 * The default `shouldRelink` treats *any* document with *any* unresolved reference as needing a
 * full relink on *every* subsequent change, on the reasonable-in-general assumption that the
 * change might have fixed it. But in a real TorqueScript project the vast majority of documents
 * legitimately have permanently-unresolved dynamic-field/method references by design (measured:
 * 342 of 367 documents in one real project) - so a single-file edit was triggering a near-total
 * workspace relink (~22s) instead of a genuinely incremental update. Narrowing the "might now
 * resolve" check to exclude the categories that are never going to resolve fixes this without
 * losing the real benefit (a newly-added function/class *should* still trigger a relink of
 * documents that were waiting on it).
 */
export class TorquescriptDocumentBuilder extends DefaultDocumentBuilder {

    protected override shouldRelink(document: LangiumDocument, changedUris: Set<string>): boolean {
        const hasPotentiallyFixableError = document.references.some(ref => {
            const error = ref.error;
            return error !== undefined && !ALWAYS_SILENT_PROPERTIES.has(error.info.property);
        });
        if (hasPotentiallyFixableError) {
            return true;
        }
        return this.indexManager.isAffected(document, changedUris);
    }
}
