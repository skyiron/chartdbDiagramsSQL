import React, {
    useState,
    useCallback,
    useMemo,
    useEffect,
    useRef,
} from 'react';
import type { DBTable } from '@/lib/domain/db-table';
import { useChartDB } from '@/hooks/use-chartdb';
import { useTheme } from '@/hooks/use-theme';
import { CodeSnippet } from '@/components/code-snippet/code-snippet';
import type { EffectiveTheme } from '@/context/theme-context/theme-context';
import { importer, Parser } from '@dbml/core';
import { exportBaseSQL } from '@/lib/data/export-metadata/export-sql-script';
import type { Diagram } from '@/lib/domain/diagram';
import { useToast } from '@/components/toast/use-toast';
import { setupDBMLLanguage } from '@/components/code-snippet/languages/dbml-language';
import { DatabaseType } from '@/lib/domain/database-type';
import { generateId, getOperatingSystem } from '@/lib/utils';
import { importDBMLToDiagram } from '@/lib/dbml-import';
import { useMonaco } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import type { DBRelationship } from '@/lib/domain/db-relationship';
import { useHotkeys } from 'react-hotkeys-hook';
import { Loader2 } from 'lucide-react';

export interface TableDBMLProps {
    filteredTables: DBTable[];
    toggleEditMode?: () => boolean;
}

const getEditorTheme = (theme: EffectiveTheme) => {
    return theme === 'dark' ? 'dbml-dark' : 'dbml-light';
};

interface DBMLError {
    message: string;
    line: number;
    column: number;
}

function parseDBMLError(error: unknown): DBMLError | null {
    try {
        if (typeof error === 'string') {
            const parsed = JSON.parse(error);
            if (parsed.diags?.[0]) {
                const diag = parsed.diags[0];
                return {
                    message: diag.message,
                    line: diag.location.start.line,
                    column: diag.location.start.column,
                };
            }
        } else if (error && typeof error === 'object' && 'diags' in error) {
            const parsed = error as {
                diags: Array<{
                    message: string;
                    location: { start: { line: number; column: number } };
                }>;
            };
            if (parsed.diags?.[0]) {
                return {
                    message: parsed.diags[0].message,
                    line: parsed.diags[0].location.start.line,
                    column: parsed.diags[0].location.start.column,
                };
            }
        }
    } catch (e) {
        console.error('Error parsing DBML error:', e);
    }
    return null;
}

const databaseTypeToImportFormat = (
    type: DatabaseType
): 'mysql' | 'postgres' | 'mssql' => {
    switch (type) {
        case DatabaseType.SQL_SERVER:
            return 'mssql';
        case DatabaseType.MYSQL:
        case DatabaseType.MARIADB:
            return 'mysql';
        case DatabaseType.POSTGRESQL:
        case DatabaseType.COCKROACHDB:
        case DatabaseType.SQLITE:
            return 'postgres';
        default:
            return 'postgres';
    }
};

export const EditorTableDBML: React.FC<TableDBMLProps> = ({
    filteredTables,
    toggleEditMode,
}) => {
    const {
        currentDiagram,
        updateTablesState,
        addTables,
        removeRelationships,
        removeTables,
        addRelationships,
    } = useChartDB();
    const { effectiveTheme } = useTheme();
    const { toast } = useToast();
    const [dbmlContent, setDbmlContent] = useState<string>('');
    const [dbmlError, setDbmlError] = useState<DBMLError | null>(null);
    const [isApplying, setIsApplying] = useState(false);
    const monacoInstance = useMonaco();
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
    const operatingSystem = useMemo(() => getOperatingSystem(), []);
    const skipContentChangeRef = useRef<boolean>(false);

    // Keep track of the original generated DBML for comparison
    const [originalDbmlContent, setOriginalDbmlContent] = useState<string>('');

    // Track user interaction state
    const changesInProgressRef = useRef<boolean>(false);
    const lastValidContentRef = useRef<string>('');
    const userHasEditedRef = useRef<boolean>(false);
    const lastUpdateTimeRef = useRef<number>(Date.now());
    const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Generate DBML from the diagram
    const generateDBML = useMemo(() => {
        const filteredDiagram: Diagram = {
            ...currentDiagram,
            tables: filteredTables,
            relationships:
                currentDiagram.relationships?.filter((rel) => {
                    const sourceTable = filteredTables.find(
                        (t) => t.id === rel.sourceTableId
                    );
                    const targetTable = filteredTables.find(
                        (t) => t.id === rel.targetTableId
                    );

                    return sourceTable && targetTable;
                }) ?? [],
        } satisfies Diagram;

        const filteredDiagramWithoutSpaces: Diagram = {
            ...filteredDiagram,
            tables:
                filteredDiagram.tables?.map((table) => ({
                    ...table,
                    name: table.name.replace(/\s/g, '_'),
                    fields: table.fields.map((field) => ({
                        ...field,
                        name: field.name.replace(/\s/g, '_'),
                    })),
                    indexes: table.indexes?.map((index) => ({
                        ...index,
                        name: index.name.replace(/\s/g, '_'),
                    })),
                })) ?? [],
        } satisfies Diagram;

        const baseScript = exportBaseSQL(filteredDiagramWithoutSpaces, true);

        try {
            const importFormat = databaseTypeToImportFormat(
                currentDiagram.databaseType
            );

            return importer.import(baseScript, importFormat);
        } catch (e) {
            console.error(e);

            toast({
                title: 'Error',
                description:
                    'Failed to generate DBML. We would appreciate if you could report this issue!',
                variant: 'destructive',
            });

            return '';
        }
    }, [currentDiagram, filteredTables, toast]);

    // Load initial content
    useEffect(() => {
        console.log(
            'DBML DEBUG: Initializing editor with current diagram state'
        );

        const newContent = generateDBML;
        setDbmlContent(newContent);
        setOriginalDbmlContent(newContent); // Store original content
        lastValidContentRef.current = newContent;
    }, [generateDBML]);

    // Helper function to find length of common substring
    const commonSubstringLength = (a: string, b: string): number => {
        a = a.toLowerCase();
        b = b.toLowerCase();
        let score = 0;
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
            if (a[i] === b[i]) {
                score++;
            } else {
                break;
            }
        }
        return score;
    };

    // Modified update content function that preserves cursor
    const updateEditorContent = useCallback(
        (newContent: string, shouldSaveCursor = true) => {
            if (!editorRef.current) return;

            const editor = editorRef.current;
            const model = editor.getModel();
            if (!model) return;

            // Don't update if user is actively typing - stricter check (500ms)
            if (
                userHasEditedRef.current &&
                Date.now() - lastUpdateTimeRef.current < 500
            ) {
                console.log(
                    'DBML DEBUG: Skipping content update during active editing'
                );
                return;
            }

            // Only update if content actually changed
            const currentContent = model.getValue();
            if (currentContent === newContent) {
                console.log('DBML DEBUG: Content unchanged, skipping update');
                return;
            }

            // Skip content change handler during programmatic update
            skipContentChangeRef.current = true;

            try {
                // Save the current view state, cursor position and selection
                const viewState = editor.saveViewState();
                const currentPosition = editor.getPosition();
                const currentSelection = editor.getSelection();

                // Get the current scroll position
                const scrollTop = editor.getScrollTop();
                const scrollLeft = editor.getScrollLeft();

                // Record cursor line content before update to help maintain context
                const cursorLineNumber = currentPosition?.lineNumber;
                const cursorLineContent = cursorLineNumber
                    ? model.getLineContent(cursorLineNumber)
                    : null;

                // Instead of setValue, use edit operations to minimize content refresh
                model.pushEditOperations(
                    [], // No selections to track
                    [
                        {
                            range: model.getFullModelRange(),
                            text: newContent,
                        },
                    ],
                    () => null // No cursor handling here
                );

                // Update state
                setDbmlContent(newContent);

                // Restore view state and cursor position
                if (viewState && shouldSaveCursor && currentPosition) {
                    // Try to find closest position that preserves editing context
                    const newLineCount = model.getLineCount();

                    // Find the best line to position cursor based on content similarity
                    let bestLine = Math.min(
                        currentPosition.lineNumber,
                        newLineCount
                    );
                    let bestMatch = 0;

                    // If we have a cursor line, try to find similar content in new text
                    if (
                        cursorLineContent &&
                        cursorLineContent.trim().length > 0
                    ) {
                        // Look at +/- 5 lines from current cursor position
                        const startLine = Math.max(1, bestLine - 5);
                        const endLine = Math.min(newLineCount, bestLine + 5);

                        for (let i = startLine; i <= endLine; i++) {
                            const lineContent = model.getLineContent(i);
                            // Simple similarity check
                            const similarity = commonSubstringLength(
                                cursorLineContent,
                                lineContent
                            );
                            if (similarity > bestMatch) {
                                bestMatch = similarity;
                                bestLine = i;
                            }
                        }
                    }

                    // Calculate column position - try to keep same column or adapt to new line length
                    const lineMaxColumn = model.getLineMaxColumn(bestLine);
                    const bestColumn = Math.min(
                        currentPosition.column,
                        lineMaxColumn
                    );

                    // Only set position if it's valid
                    if (bestLine > 0 && bestColumn > 0) {
                        // Apply the calculated position
                        editor.setPosition({
                            lineNumber: bestLine,
                            column: bestColumn,
                        });

                        // Restore selection if applicable
                        if (
                            currentSelection &&
                            (currentSelection.startLineNumber !==
                                currentSelection.endLineNumber ||
                                currentSelection.startColumn !==
                                    currentSelection.endColumn)
                        ) {
                            try {
                                const adjustedSelection = new monaco.Selection(
                                    Math.min(
                                        currentSelection.startLineNumber,
                                        newLineCount
                                    ),
                                    Math.min(
                                        currentSelection.startColumn,
                                        model.getLineMaxColumn(
                                            Math.min(
                                                currentSelection.startLineNumber,
                                                newLineCount
                                            )
                                        )
                                    ),
                                    Math.min(
                                        currentSelection.endLineNumber,
                                        newLineCount
                                    ),
                                    Math.min(
                                        currentSelection.endColumn,
                                        model.getLineMaxColumn(
                                            Math.min(
                                                currentSelection.endLineNumber,
                                                newLineCount
                                            )
                                        )
                                    )
                                );
                                editor.setSelection(adjustedSelection);
                            } catch (e) {
                                // If selection restoration fails, keep the cursor position at least
                                console.error(
                                    'Failed to restore selection, keeping cursor position only',
                                    e
                                );
                            }
                        }

                        // Restore the scroll position to avoid jumps
                        editor.setScrollTop(scrollTop);
                        editor.setScrollLeft(scrollLeft);

                        // Don't use revealPosition as it can cause jumps
                        // Instead only ensure that the cursor is in view if outside viewport
                        const position = {
                            lineNumber: bestLine,
                            column: bestColumn,
                        };
                        // Check if position is visible by attempting to convert to screen coordinates
                        const coords =
                            editor.getScrolledVisiblePosition(position);
                        if (
                            !coords ||
                            coords.top < 0 ||
                            coords.top > editor.getLayoutInfo().height
                        ) {
                            editor.revealPositionInCenterIfOutsideViewport(
                                position
                            );
                        }

                        editor.focus();
                    }
                }
            } finally {
                skipContentChangeRef.current = false;
            }
        },
        []
    );

    // Helper function to show toast in a consistent way
    const showToast = useCallback(
        (
            title: string,
            description: string,
            variant: 'default' | 'destructive' = 'default'
        ) => {
            // Show errors immediately, debounce other toasts
            if (variant === 'destructive') {
                toast({
                    title,
                    description,
                    variant,
                });
            } else {
                // Clear any pending toast
                if (toastTimeoutRef.current) {
                    clearTimeout(toastTimeoutRef.current);
                }

                // Show the toast with a delay
                toastTimeoutRef.current = setTimeout(() => {
                    toast({
                        title,
                        description,
                        variant,
                    });
                    toastTimeoutRef.current = null;
                }, 300);
            }
        },
        [toast]
    );

    // Validate DBML syntax as the user types
    const validateDBML = useCallback((content: string | undefined) => {
        if (!content || !content.trim()) {
            setDbmlError(null);
            return true;
        }

        try {
            const parser = new Parser();
            parser.parse(content, 'dbml');
            setDbmlError(null);
            lastValidContentRef.current = content;
            return true;
        } catch (e) {
            const error = parseDBMLError(e);
            setDbmlError(error);
            return false;
        }
    }, []);

    // Apply the DBML changes to the diagram
    const applyDBMLChanges = useCallback(
        async (content: string) => {
            // Don't apply if there's an error or if changes are already in progress
            if (dbmlError || changesInProgressRef.current || isApplying) {
                return;
            }

            // Only apply if the content has changed from the original
            if (content === originalDbmlContent) {
                console.log('DBML DEBUG: No changes to apply');
                return;
            }

            // Remember if the user was actively editing
            const wasUserEditing =
                userHasEditedRef.current &&
                Date.now() - lastUpdateTimeRef.current < 2000;

            setIsApplying(true);
            changesInProgressRef.current = true;

            try {
                console.log('DBML DEBUG: Applying changes automatically');

                // Import the DBML content to create a new diagram
                const importedDiagram = await importDBMLToDiagram(content);

                // Create table name to ID mapping for the current diagram
                const currentTableMap = new Map<string, DBTable>();
                currentDiagram.tables?.forEach((table) => {
                    const key = `${table.schema || ''}.${table.name}`;
                    currentTableMap.set(key, table);
                });

                // Prepare tables to add/update with preserved positions
                const tablesToAdd: DBTable[] = [];
                const tablesToUpdate: DBTable[] = [];

                // Process imported tables
                importedDiagram.tables?.forEach((importedTable) => {
                    const tableKey = `${importedTable.schema || ''}.${importedTable.name}`;
                    const existingTable = currentTableMap.get(tableKey);

                    if (existingTable) {
                        // Preserve position, color, and ID for existing tables
                        const tableWithPreservedIds = {
                            ...importedTable,
                            id: existingTable.id,
                            x: existingTable.x,
                            y: existingTable.y,
                            color: existingTable.color,
                            // Preserve field IDs for fields that exist in both tables (matching by name)
                            fields: importedTable.fields.map(
                                (importedField) => {
                                    // Try to find matching field in existing table
                                    const existingField =
                                        existingTable.fields.find(
                                            (f) => f.name === importedField.name
                                        );
                                    if (existingField) {
                                        return {
                                            ...importedField,
                                            id: existingField.id,
                                        };
                                    }
                                    // Use the new ID for new fields
                                    return importedField;
                                }
                            ),
                        };

                        tablesToUpdate.push(tableWithPreservedIds);
                        currentTableMap.delete(tableKey); // Remove from map to track remaining tables
                    } else {
                        tablesToAdd.push(importedTable);
                    }
                });

                // Tables remaining in the map need to be removed
                const tablesToRemove = Array.from(currentTableMap.values());

                // Find relationships to update
                const importedRelationshipMap = new Map<string, boolean>();
                importedDiagram.relationships?.forEach((rel) => {
                    const importedSourceTable = importedDiagram.tables?.find(
                        (t) => t.id === rel.sourceTableId
                    );
                    const importedTargetTable = importedDiagram.tables?.find(
                        (t) => t.id === rel.targetTableId
                    );

                    if (importedSourceTable && importedTargetTable) {
                        const importedSourceField =
                            importedSourceTable.fields.find(
                                (f) => f.id === rel.sourceFieldId
                            );
                        const importedTargetField =
                            importedTargetTable.fields.find(
                                (f) => f.id === rel.targetFieldId
                            );

                        if (importedSourceField && importedTargetField) {
                            // Create a unique key for this relationship based on table and field names
                            const key = `${importedSourceTable.name}.${importedSourceField.name}:${importedTargetTable.name}.${importedTargetField.name}`;
                            importedRelationshipMap.set(key, true);

                            // Also add the reverse direction as relationships can be defined in either direction
                            const reverseKey = `${importedTargetTable.name}.${importedTargetField.name}:${importedSourceTable.name}.${importedSourceField.name}`;
                            importedRelationshipMap.set(reverseKey, true);
                        }
                    }
                });

                const relationshipsToRemove =
                    currentDiagram.relationships?.filter((rel) => {
                        // Remove relationships connected to tables that will be removed
                        const isConnectedToRemovedTable = tablesToRemove.some(
                            (table) =>
                                table.id === rel.sourceTableId ||
                                table.id === rel.targetTableId
                        );

                        if (isConnectedToRemovedTable) {
                            return true;
                        }

                        // Check if this relationship exists in the imported DBML
                        const currentSourceTable = currentDiagram.tables?.find(
                            (t) => t.id === rel.sourceTableId
                        );
                        const currentTargetTable = currentDiagram.tables?.find(
                            (t) => t.id === rel.targetTableId
                        );

                        if (currentSourceTable && currentTargetTable) {
                            const currentSourceField =
                                currentSourceTable.fields.find(
                                    (f) => f.id === rel.sourceFieldId
                                );
                            const currentTargetField =
                                currentTargetTable.fields.find(
                                    (f) => f.id === rel.targetFieldId
                                );

                            if (currentSourceField && currentTargetField) {
                                // Create a key to look up in our map of imported relationships
                                const relKey = `${currentSourceTable.name}.${currentSourceField.name}:${currentTargetTable.name}.${currentTargetField.name}`;
                                const relReverseKey = `${currentTargetTable.name}.${currentTargetField.name}:${currentSourceTable.name}.${currentSourceField.name}`;

                                // If this relationship doesn't exist in the imported DBML, mark it for removal
                                if (
                                    !importedRelationshipMap.has(relKey) &&
                                    !importedRelationshipMap.has(relReverseKey)
                                ) {
                                    return true;
                                }
                            }
                        }

                        // Check if the specific fields involved in the relationship have changed in the updated tables
                        const sourceTable = tablesToUpdate.find(
                            (t) => t.id === rel.sourceTableId
                        );
                        const targetTable = tablesToUpdate.find(
                            (t) => t.id === rel.targetTableId
                        );

                        if (sourceTable || targetTable) {
                            // Get the field names from the current tables
                            const sourceTableFields =
                                currentDiagram.tables?.find(
                                    (t) => t.id === rel.sourceTableId
                                )?.fields || [];
                            const targetTableFields =
                                currentDiagram.tables?.find(
                                    (t) => t.id === rel.targetTableId
                                )?.fields || [];

                            const sourceFieldName = sourceTableFields.find(
                                (f) => f.id === rel.sourceFieldId
                            )?.name;
                            const targetFieldName = targetTableFields.find(
                                (f) => f.id === rel.targetFieldId
                            )?.name;

                            if (!sourceFieldName || !targetFieldName) {
                                return true; // Can't find field names, something is wrong, remove relationship
                            }

                            // Check if the fields still exist in the updated tables by name
                            if (sourceTable) {
                                const sourceFieldExists =
                                    sourceTable.fields.some(
                                        (field) =>
                                            field.name === sourceFieldName
                                    );
                                if (!sourceFieldExists) {
                                    return true; // Source field no longer exists, remove relationship
                                }
                            }

                            if (targetTable) {
                                const targetFieldExists =
                                    targetTable.fields.some(
                                        (field) =>
                                            field.name === targetFieldName
                                    );
                                if (!targetFieldExists) {
                                    return true; // Target field no longer exists, remove relationship
                                }
                            }
                        }

                        return false;
                    }) || [];

                // Transaction: batch operations for better performance

                // 1. Remove tables and relationships first
                if (tablesToRemove.length > 0) {
                    await removeTables(tablesToRemove.map((t) => t.id));
                }

                if (relationshipsToRemove.length > 0) {
                    await removeRelationships(
                        relationshipsToRemove.map((r) => r.id)
                    );
                }

                // 2. Update existing tables
                if (tablesToUpdate.length > 0) {
                    await updateTablesState(() => {
                        return tablesToUpdate;
                    });
                }

                // 3. Add new tables
                if (tablesToAdd.length > 0) {
                    await addTables(tablesToAdd);
                }

                // Get the most up-to-date diagram with all tables after operations
                const updatedDiagram = { ...currentDiagram };

                // First, remove tables that were deleted
                updatedDiagram.tables = (updatedDiagram.tables || []).filter(
                    (table) => !tablesToRemove.some((t) => t.id === table.id)
                );

                // Then update existing tables
                updatedDiagram.tables = updatedDiagram.tables.map(
                    (table) =>
                        tablesToUpdate.find((t) => t.id === table.id) || table
                );

                // Finally add new tables with their final IDs
                updatedDiagram.tables = [
                    ...updatedDiagram.tables,
                    ...tablesToAdd,
                ];

                // Set up for relationship processing
                const allCurrentTables = updatedDiagram.tables || [];

                const tableNameToId = new Map<string, string>();
                allCurrentTables.forEach((table) => {
                    tableNameToId.set(table.name, table.id);
                });

                // Create a map of field names to IDs for each table
                const tableFieldMap = new Map<string, Map<string, string>>();
                allCurrentTables.forEach((table) => {
                    const fieldMap = new Map<string, string>();
                    table.fields.forEach((field) => {
                        fieldMap.set(field.name, field.id);
                    });
                    tableFieldMap.set(table.id, fieldMap);
                });

                // Now map the DBML relationships to actual relationships with correct IDs
                let relationshipsToAdd: DBRelationship[] = [];

                // Handle relationships directly from the imported diagram
                if (
                    importedDiagram.relationships &&
                    importedDiagram.relationships.length > 0
                ) {
                    // Create a map of table names to IDs for both current and imported diagrams
                    const tableNameToCurrentId = new Map();
                    const tableNameToImportedId = new Map();

                    // Map current tables
                    updatedDiagram.tables?.forEach((table) => {
                        tableNameToCurrentId.set(table.name, table.id);
                    });

                    // Map imported tables
                    importedDiagram.tables?.forEach((table) => {
                        tableNameToImportedId.set(table.name, table.id);
                    });

                    // Map relationships by table and field names
                    relationshipsToAdd = importedDiagram.relationships
                        .map((rel) => {
                            try {
                                // Get source and target tables from imported diagram
                                const importedSourceTable =
                                    importedDiagram.tables?.find(
                                        (t) => t.id === rel.sourceTableId
                                    );
                                const importedTargetTable =
                                    importedDiagram.tables?.find(
                                        (t) => t.id === rel.targetTableId
                                    );

                                if (
                                    !importedSourceTable ||
                                    !importedTargetTable
                                ) {
                                    return null;
                                }

                                // Get source and target fields from imported diagram
                                const importedSourceField =
                                    importedSourceTable.fields.find(
                                        (f) => f.id === rel.sourceFieldId
                                    );
                                const importedTargetField =
                                    importedTargetTable.fields.find(
                                        (f) => f.id === rel.targetFieldId
                                    );

                                if (
                                    !importedSourceField ||
                                    !importedTargetField
                                ) {
                                    return null;
                                }

                                // Find corresponding tables in current diagram by name
                                const currentSourceTableId =
                                    tableNameToCurrentId.get(
                                        importedSourceTable.name
                                    );
                                const currentTargetTableId =
                                    tableNameToCurrentId.get(
                                        importedTargetTable.name
                                    );

                                if (
                                    !currentSourceTableId ||
                                    !currentTargetTableId
                                ) {
                                    return null;
                                }

                                // Find corresponding fields in current tables by name
                                const currentSourceTable =
                                    updatedDiagram.tables?.find(
                                        (t) => t.id === currentSourceTableId
                                    );
                                const currentTargetTable =
                                    updatedDiagram.tables?.find(
                                        (t) => t.id === currentTargetTableId
                                    );

                                if (
                                    !currentSourceTable ||
                                    !currentTargetTable
                                ) {
                                    return null;
                                }

                                const currentSourceField =
                                    currentSourceTable.fields.find(
                                        (f) =>
                                            f.name === importedSourceField.name
                                    );
                                const currentTargetField =
                                    currentTargetTable.fields.find(
                                        (f) =>
                                            f.name === importedTargetField.name
                                    );

                                if (
                                    !currentSourceField ||
                                    !currentTargetField
                                ) {
                                    return null;
                                }

                                // Check if this relationship already exists
                                const existingRelationship =
                                    currentDiagram.relationships?.find(
                                        (existingRel) =>
                                            (existingRel.sourceTableId ===
                                                currentSourceTableId &&
                                                existingRel.targetTableId ===
                                                    currentTargetTableId &&
                                                existingRel.sourceFieldId ===
                                                    currentSourceField.id &&
                                                existingRel.targetFieldId ===
                                                    currentTargetField.id) ||
                                            // Check the reverse direction too
                                            (existingRel.sourceTableId ===
                                                currentTargetTableId &&
                                                existingRel.targetTableId ===
                                                    currentSourceTableId &&
                                                existingRel.sourceFieldId ===
                                                    currentTargetField.id &&
                                                existingRel.targetFieldId ===
                                                    currentSourceField.id)
                                    );

                                if (existingRelationship) {
                                    return null; // Skip adding new relationships for ones that already exist
                                }

                                // Return properly mapped relationship
                                return {
                                    id: generateId(), // Generate a new ID for the relationship
                                    sourceTableId: currentSourceTableId,
                                    targetTableId: currentTargetTableId,
                                    sourceFieldId: currentSourceField.id,
                                    targetFieldId: currentTargetField.id,
                                    // Copy other properties from the imported relationship
                                    sourceCardinality: rel.sourceCardinality,
                                    targetCardinality: rel.targetCardinality,
                                    // Ensure schema properties are properly typed
                                    sourceSchema:
                                        currentSourceTable.schema || '',
                                    targetSchema:
                                        currentTargetTable.schema || '',
                                    name: `${importedSourceTable.name}_${importedSourceField.name}_${importedTargetTable.name}_${importedTargetField.name}`,
                                    createdAt: Date.now(),
                                };
                            } catch (e) {
                                console.error(
                                    'DBML DEBUG: Error mapping relationship:',
                                    e
                                );
                                return null;
                            }
                        })
                        .filter((rel) => rel !== null) as DBRelationship[];
                }

                // Add the new relationships
                if (relationshipsToAdd.length > 0) {
                    await addRelationships(relationshipsToAdd);
                }

                // After all changes are applied, regenerate the DBML to show the current state
                const updatedDBML = await importer.import(
                    exportBaseSQL(
                        {
                            ...currentDiagram,
                            tables: updatedDiagram.tables,
                            // Include all current relationships, both existing and newly added
                            relationships: [
                                ...(currentDiagram.relationships || []).filter(
                                    (rel) =>
                                        !relationshipsToRemove.some(
                                            (r) => r.id === rel.id
                                        )
                                ),
                                ...relationshipsToAdd,
                            ],
                        },
                        true
                    ),
                    databaseTypeToImportFormat(currentDiagram.databaseType)
                );

                // Don't update the editor content if the user is actively editing
                // Just silently update the state
                if (wasUserEditing) {
                    // Update internal state variables only, without modifying the editor
                    setOriginalDbmlContent(updatedDBML);
                    lastValidContentRef.current = updatedDBML;
                    console.log(
                        'DBML DEBUG: User is actively editing, skipping editor update'
                    );
                } else {
                    // Only update the editor if the user wasn't actively editing
                    updateEditorContent(updatedDBML);
                    setOriginalDbmlContent(updatedDBML);
                    lastValidContentRef.current = updatedDBML;
                }

                // Count changes for the toast notification
                const changesCount =
                    tablesToAdd.length +
                    tablesToRemove.length +
                    tablesToUpdate.length +
                    relationshipsToAdd.length +
                    relationshipsToRemove.length;

                // Only show toast for significant changes
                if (changesCount > 0) {
                    // Show toast notification for successful changes
                    showToast(
                        'DBML Changes Applied',
                        'Changes have been applied to the diagram.',
                        'default'
                    );
                }
            } catch (e) {
                console.error('Error applying DBML changes:', e);
                showToast(
                    'Error',
                    'Failed to apply DBML changes. Please check your DBML syntax.',
                    'destructive'
                );
            } finally {
                setIsApplying(false);
                changesInProgressRef.current = false;
            }
        },
        [
            dbmlError,
            originalDbmlContent,
            currentDiagram,
            addTables,
            removeTables,
            removeRelationships,
            updateTablesState,
            addRelationships,
            showToast,
            isApplying,
            updateEditorContent,
        ]
    );

    // Handle editor content changes
    const handleDBMLChange = useCallback(
        (value: string | undefined) => {
            if (value !== undefined && !skipContentChangeRef.current) {
                const contentChanged = value !== dbmlContent;

                if (contentChanged) {
                    // Update last edit time and mark as edited
                    lastUpdateTimeRef.current = Date.now();
                    userHasEditedRef.current = true;

                    // Update state without triggering editor refresh
                    setDbmlContent(value);

                    // Validate the content before applying changes
                    const isValid = validateDBML(value);

                    if (isValid && value !== originalDbmlContent) {
                        // Schedule auto-apply if content is valid and changed
                        applyDBMLChanges(value);
                    }
                }
            }
        },
        [validateDBML, dbmlContent, originalDbmlContent, applyDBMLChanges]
    );

    // Add global hotkey for toggling edit mode
    useHotkeys(
        operatingSystem === 'mac' ? 'meta+e' : 'ctrl+e',
        (event) => {
            if (toggleEditMode) {
                event.preventDefault();
                event.stopPropagation();
                console.log(
                    'DBML DEBUG: Global hotkey Cmd+E / Ctrl+E pressed in editor'
                );
                toggleEditMode();
            }
        },
        {
            enableOnFormTags: true,
            preventDefault: true,
        },
        [toggleEditMode]
    );

    // Handle editor reference
    const handleEditorDidMount = useCallback(
        (editor: monaco.editor.IStandaloneCodeEditor) => {
            editorRef.current = editor;
            console.log('DBML DEBUG: Editor mounted');

            // Track editor interactions to know when user is actively editing
            editor.onDidChangeCursorPosition(() => {
                lastUpdateTimeRef.current = Date.now();
            });

            // Track content changes directly
            editor.onDidChangeModelContent(() => {
                if (!skipContentChangeRef.current) {
                    lastUpdateTimeRef.current = Date.now();
                    userHasEditedRef.current = true;
                }
            });

            // Add command to handle Cmd+E / Ctrl+E to toggle edit mode
            editor.addCommand(
                monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE,
                () => {
                    console.log('DBML DEBUG: Editor Cmd+E / Ctrl+E pressed');
                    if (toggleEditMode) {
                        toggleEditMode();
                    }
                }
            );
        },
        [toggleEditMode]
    );

    // Set error markers in editor
    useEffect(() => {
        if (monacoInstance && editorRef.current) {
            if (dbmlError) {
                monacoInstance.editor.setModelMarkers(
                    editorRef.current.getModel()!,
                    'dbml-validator',
                    [
                        {
                            startLineNumber: dbmlError.line,
                            startColumn: dbmlError.column,
                            endLineNumber: dbmlError.line,
                            endColumn: dbmlError.column + 1,
                            message: dbmlError.message,
                            severity: monaco.MarkerSeverity.Error,
                        },
                    ]
                );
            } else {
                monacoInstance.editor.setModelMarkers(
                    editorRef.current.getModel()!,
                    'dbml-validator',
                    []
                );
            }
        }
    }, [dbmlError, monacoInstance]);

    return (
        <div className="flex h-full flex-col">
            <div className="mb-2 rounded bg-blue-100 p-2 text-sm text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
                <strong>Interactive DBML Editor</strong>: Edit your diagram
                directly using DBML syntax. Changes will be applied
                automatically.
                {isApplying && (
                    <span className="ml-2 inline-flex items-center">
                        <Loader2 className="mr-1 size-3 animate-spin" />{' '}
                        Applying changes...
                    </span>
                )}
            </div>

            {dbmlError && (
                <div className="mb-2 rounded bg-red-100 p-2 text-sm text-red-500 dark:bg-red-900/20">
                    Error at line {dbmlError.line}, column {dbmlError.column}:{' '}
                    {dbmlError.message}
                </div>
            )}

            <CodeSnippet
                code={dbmlContent}
                className="my-0.5 flex-1"
                editorProps={{
                    height: '100%',
                    defaultLanguage: 'dbml',
                    beforeMount: setupDBMLLanguage,
                    loading: false,
                    theme: getEditorTheme(effectiveTheme),
                    onChange: handleDBMLChange,
                    onMount: handleEditorDidMount,
                    options: {
                        wordWrap: 'off',
                        mouseWheelZoom: false,
                        domReadOnly: false, // Allow editing
                        readOnly: false, // Allow editing
                    },
                }}
            />
        </div>
    );
};
