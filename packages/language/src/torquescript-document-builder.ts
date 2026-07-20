import type { LangiumDocument, URI } from 'langium';
import { Cancellation, DefaultDocumentBuilder, DocumentState } from 'langium';

/**
 * Reference properties whose unresolved state is *expected and permanent* by design - dynamic
 * datablock/object fields (`slot`), and best-effort method/field-via-receiver-type resolution
 * (`calledMethod`, `field` on PrimaryExprSuffix). These are never going to "become resolved by
 * some other file changing" the way a genuinely missing function or class might.
 */
const ALWAYS_SILENT_PROPERTIES = new Set(['slot', 'calledMethod', 'field']);

/**
 * A document has a "potentially fixable" reference error when it references a function/class/etc.
 * by name that currently doesn't resolve - but *could* start resolving if some other document
 * later defines that name. (Excludes the always-silent categories above, which never resolve.)
 */
function hasPotentiallyFixableError(document: LangiumDocument): boolean {
    return document.references.some(ref => {
        const error = ref.error;
        return error !== undefined && !ALWAYS_SILENT_PROPERTIES.has(error.info.property);
    });
}

/**
 * Makes single-file edits genuinely incremental.
 *
 * The default `shouldRelink` treats *any* document with *any* unresolved reference as needing a
 * relink on *every* subsequent change, on the reasonable-in-general assumption that the change
 * might have fixed it. But in a real TorqueScript project the vast majority of documents
 * legitimately have unresolved references by design (measured: ~340 of 367 documents in one real
 * project). Even after narrowing that to only "potentially fixable" errors, ~50 documents were
 * still being relinked+revalidated on *every keystroke* - measured at ~4.5s per edit on a real
 * project, which is what made autocomplete "take ages" (the relink blocks the completion response).
 *
 * The key insight: a previously-unresolved function/class reference can only *newly* resolve (or
 * newly break) if the set of globally-exported symbol *names* actually changes - i.e. a function,
 * named object, or datablock is added, removed, or renamed. Ordinary edits (typing inside a
 * function body, changing a string, etc.) leave the exported-name set untouched, so no unresolved
 * reference anywhere can change state, so relinking those documents is pure waste.
 *
 * So: the per-keystroke `shouldRelink` fast path relinks only documents genuinely affected via the
 * resolved-reference index (Langium's default `isAffected`). The expensive "relink documents that
 * were waiting on a now-defined symbol" pass runs from `update()` *only when a changed document's
 * exported-name set actually changed*, and even then only for documents whose unresolved
 * references name one of the specific added/removed symbols.
 */
export class TorquescriptDocumentBuilder extends DefaultDocumentBuilder {

    protected override shouldRelink(document: LangiumDocument, changedUris: Set<string>): boolean {
        return this.indexManager.isAffected(document, changedUris);
    }

    override async update(changed: URI[], deleted: URI[], cancelToken = Cancellation.CancellationToken.None): Promise<void> {
        const changedUriSet = new Set([...changed, ...deleted].map(uri => uri.toString()));
        const exportsBefore = this.collectExportedNames(changedUriSet);

        await super.update(changed, deleted, cancelToken);

        const exportsAfter = this.collectExportedNames(changedUriSet);
        const changedNames = this.symmetricDifference(exportsBefore, exportsAfter);
        if (changedNames.size > 0) {
            await this.relinkDependentsOf(changedNames, changedUriSet, cancelToken);
        }
    }

    /**
     * Relinks every document that has an unresolved function/class reference to one of the given
     * (now added/removed) symbol names - used both from `update()` when an edit changes the
     * exported-name set, and by the workspace manager after (re)loading the console-API document
     * (which adds/removes the whole built-in function/class set at once).
     */
    async relinkDependentsOf(symbolNames: Set<string>, alreadyBuilt: Set<string>, cancelToken = Cancellation.CancellationToken.None): Promise<void> {
        const toRelink = this.langiumDocuments.all
            .filter(document =>
                !alreadyBuilt.has(document.uri.toString())
                && hasPotentiallyFixableError(document)
                && document.references.some(ref => ref.error !== undefined && symbolNames.has(ref.error.info.reference.$refText.toLowerCase())))
            .toArray();
        if (toRelink.length === 0) {
            return;
        }
        for (const document of toRelink) {
            this.resetToState(document, DocumentState.ComputedScopes);
        }
        await this.buildDocuments(this.sortDocuments(toRelink), this.updateBuildOptions, cancelToken);
    }

    /** Every fixable-error document, keyed to relink against the full symbol set - used when the console API (re)loads and the specific changed names aren't tracked per-document. */
    async relinkAllUnresolved(cancelToken = Cancellation.CancellationToken.None): Promise<void> {
        const toRelink = this.langiumDocuments.all
            .filter(document => hasPotentiallyFixableError(document))
            .toArray();
        if (toRelink.length === 0) {
            return;
        }
        for (const document of toRelink) {
            this.resetToState(document, DocumentState.ComputedScopes);
        }
        await this.buildDocuments(this.sortDocuments(toRelink), this.updateBuildOptions, cancelToken);
    }

    private collectExportedNames(uris: Set<string>): Set<string> {
        const names = new Set<string>();
        for (const uri of uris) {
            for (const description of this.indexManager.allElements(undefined, new Set([uri]))) {
                names.add(description.name.toLowerCase());
            }
        }
        return names;
    }

    private symmetricDifference(a: Set<string>, b: Set<string>): Set<string> {
        const result = new Set<string>();
        for (const name of a) {
            if (!b.has(name)) {
                result.add(name);
            }
        }
        for (const name of b) {
            if (!a.has(name)) {
                result.add(name);
            }
        }
        return result;
    }
}
