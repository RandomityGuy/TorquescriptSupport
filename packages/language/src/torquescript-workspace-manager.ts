import type { Cancellation, LangiumDocument, WorkspaceFolder } from 'langium';
import { DefaultWorkspaceManager, DocumentState, URI, UriUtils } from 'langium';
import type { LangiumSharedServices } from 'langium/lsp';
import { watch, type FSWatcher } from 'node:fs';
import { buildConsoleApiDocument } from './console-api/build-console-api-document.js';
import { parseConsoleClasses, parseConsoleFunctions } from './console-api/parse-console-dump.js';
import type { ConsoleApiModel } from './generated/ast.js';
import type { TorquescriptServices } from './torquescript-module.js';

const CONFIG_FILE_NAME = 'torquescript.config.json';
const RELOAD_DEBOUNCE_MS = 300;

interface ConsoleApiConfig {
    consoleClasses?: string;
    consoleFunctions?: string;
}

/**
 * Loads a per-workspace-folder "console API" document (built-in global functions and engine
 * classes, e.g. from dumpConsoleFunctions()/dumpConsoleClasses()) if a torquescript.config.json
 * is present. Watches the config and referenced files so users can swap in a different game's
 * dumps without reloading the extension.
 */
export class TorquescriptWorkspaceManager extends DefaultWorkspaceManager {
    private readonly sharedServices: LangiumSharedServices;
    private readonly watchers: FSWatcher[] = [];

    constructor(services: LangiumSharedServices) {
        super(services);
        this.sharedServices = services;
    }

    /**
     * Reports the initial workspace parse+index+link+validate pass as an LSP work-done progress
     * notification (VSCode renders this in the status bar), so users can see how far along a
     * potentially slow first-time indexing pass is instead of just waiting with no feedback.
     * Only meaningful for the initial load - incremental rebuilds after that are fast and don't
     * report progress.
     */
    override async initializeWorkspace(folders: WorkspaceFolder[], cancelToken?: Cancellation.CancellationToken): Promise<void> {
        const connection = this.sharedServices.lsp?.Connection;
        if (!connection) {
            await super.initializeWorkspace(folders, cancelToken);
            return;
        }

        const total = (await Promise.all(
            folders.map(folder => this.searchFolder(this.getRootFolder(folder)))
        )).reduce((sum, uris) => sum + uris.length, 0);

        const progress = await connection.window.createWorkDoneProgress();
        progress.begin('TorqueScript: indexing workspace', 0, undefined, false);

        let completed = 0;
        const subscription = total > 0
            ? this.documentBuilder.onDocumentPhase(DocumentState.Validated, () => {
                completed++;
                const percentage = Math.min(100, Math.round((completed / total) * 100));
                progress.report(percentage, `${completed}/${total} files`);
            })
            : undefined;

        try {
            await super.initializeWorkspace(folders, cancelToken);
        } finally {
            subscription?.dispose();
            progress.done();
        }
    }

    protected override async loadAdditionalDocuments(
        folders: WorkspaceFolder[],
        collector: (document: LangiumDocument) => void
    ): Promise<void> {
        for (const folder of folders) {
            const folderUri = URI.parse(folder.uri);
            await this.loadConsoleApiForFolder(folderUri, collector);
            // Watch the workspace root itself (not just the config/dump files) so that creating
            // torquescript.config.json - or the dump files it points to - after the project was
            // already opened is picked up too, not just edits to files that already existed.
            this.watchFolderRoot(folderUri);
        }
    }

    private consoleApiUri(folderUri: URI): URI {
        // The path must resolve back to this language via the ServiceRegistry's extension-based
        // lookup (used e.g. by the IndexManager when indexing this document), so it needs to end
        // in one of the language's registered file extensions.
        return URI.parse(`torquescript-builtin:///${encodeURIComponent(folderUri.toString())}/console-api.cs`);
    }

    private async readConfig(folderUri: URI): Promise<ConsoleApiConfig | undefined> {
        const configUri = UriUtils.joinPath(folderUri, CONFIG_FILE_NAME);
        let configText: string;
        try {
            configText = await this.fileSystemProvider.readFile(configUri);
        } catch {
            return undefined;
        }
        try {
            return JSON.parse(configText) as ConsoleApiConfig;
        } catch (err) {
            console.warn(`Failed to parse ${CONFIG_FILE_NAME}: ${String(err)}`);
            return undefined;
        }
    }

    private async buildDocument(folderUri: URI, config: ConsoleApiConfig): Promise<LangiumDocument<ConsoleApiModel> | undefined> {
        const functions = config.consoleFunctions
            ? parseConsoleFunctions(await this.fileSystemProvider.readFile(UriUtils.joinPath(folderUri, config.consoleFunctions)))
            : [];
        const classes = config.consoleClasses
            ? parseConsoleClasses(await this.fileSystemProvider.readFile(UriUtils.joinPath(folderUri, config.consoleClasses)))
            : [];
        if (functions.length === 0 && classes.length === 0) {
            return undefined;
        }

        const languageServices = this.sharedServices.ServiceRegistry.all[0] as TorquescriptServices;
        return buildConsoleApiDocument(
            functions,
            classes,
            this.consoleApiUri(folderUri),
            this.sharedServices.workspace.LangiumDocumentFactory,
            languageServices
        );
    }

    private async loadConsoleApiForFolder(folderUri: URI, collector: (document: LangiumDocument) => void): Promise<void> {
        const config = await this.readConfig(folderUri);
        if (!config) {
            return;
        }
        try {
            const document = await this.buildDocument(folderUri, config);
            if (document) {
                collector(document);
            }
        } catch (err) {
            console.warn(`Failed to load TorqueScript console API for ${folderUri.toString()}: ${String(err)}`);
        }
    }

    /**
     * Watches the workspace folder's root directory (rather than specific files, which may not
     * exist yet) so that adding torquescript.config.json - or editing/creating the dump files it
     * points to - after the project was already opened still triggers a reload. This also covers
     * ordinary edits to files that already existed, since directory watches report per-file
     * change events for their direct children on all platforms Node supports.
     */
    private watchFolderRoot(folderUri: URI): void {
        let debounceTimer: ReturnType<typeof setTimeout> | undefined;
        const scheduleReload = (): void => {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            debounceTimer = setTimeout(() => {
                // Routed through the workspace lock: without this, a watch event firing while the
                // initial (potentially 60+ second, on a large project) workspace build is still in
                // progress races directly against DocumentBuilder's internal state - observed as a
                // spurious "ENOENT reading the synthetic console-api URI" crash, since `mutex.write`
                // is exactly what DefaultWorkspaceManager itself uses to serialize the initial build.
                this.mutex.write(() => this.reloadConsoleApi(folderUri)).catch(err => {
                    console.warn(`Failed to reload TorqueScript console API for ${folderUri.toString()}: ${String(err)}`);
                });
            }, RELOAD_DEBOUNCE_MS);
        };

        try {
            const watcher = watch(folderUri.fsPath, scheduleReload);
            this.watchers.push(watcher);
        } catch (err) {
            console.warn(`Failed to watch ${folderUri.toString()} for TorqueScript console API changes: ${String(err)}`);
        }
    }

    private async reloadConsoleApi(folderUri: URI): Promise<void> {
        const documentUri = this.consoleApiUri(folderUri);
        const existed = this.langiumDocuments.hasDocument(documentUri);
        if (existed) {
            this.langiumDocuments.deleteDocument(documentUri);
        }

        const config = await this.readConfig(folderUri);
        if (config) {
            const document = await this.buildDocument(folderUri, config);
            if (document) {
                this.langiumDocuments.addDocument(document);
                // Rebuild via `build()`, not `update()`: `update()` unconditionally invalidates
                // and reparses anything in its `changed` list from its live source (disk/open
                // editor), which this synthetic fromModel() document has none of. `build()` is the
                // same mechanism the initial workspace load already uses successfully for it.
                await this.documentBuilder.build([document], { validation: false });
                // Separately trigger Langium's built-in sweep that relinks any document with an
                // existing unresolved reference (it does this unconditionally, independent of
                // what's passed here) so open files pick up the now-available functions/classes.
                await this.documentBuilder.update([], []);
                return;
            }
        }

        // No config (or it no longer resolves to any functions/classes): if a synthetic document
        // existed before, report it as deleted so dependent documents re-check their references.
        if (existed) {
            await this.documentBuilder.update([], [documentUri]);
        }
    }
}
