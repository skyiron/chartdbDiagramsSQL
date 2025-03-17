import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { TableList } from './table-list/table-list';
import { Button } from '@/components/button/button';
import { Table, List, X, Code, Edit, Eye } from 'lucide-react';
import { Input } from '@/components/input/input';
import type { DBTable } from '@/lib/domain/db-table';
import { shouldShowTablesBySchemaFilter } from '@/lib/domain/db-table';
import { useChartDB } from '@/hooks/use-chartdb';
import { useLayout } from '@/hooks/use-layout';
import { EmptyState } from '@/components/empty-state/empty-state';
import { ScrollArea } from '@/components/scroll-area/scroll-area';
import { useTranslation } from 'react-i18next';
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '@/components/tooltip/tooltip';
import { useViewport } from '@xyflow/react';
import { useDialog } from '@/hooks/use-dialog';
import { TableDBML } from './table-dbml/table-dbml';
import { EditorTableDBML } from './table-dbml/editor-table-dbml';
import { useHotkeys } from 'react-hotkeys-hook';
import { getOperatingSystem } from '@/lib/utils';

export interface TablesSectionProps {}

export const TablesSection: React.FC<TablesSectionProps> = () => {
    const { createTable, tables, filteredSchemas, schemas } = useChartDB();
    const { openTableSchemaDialog } = useDialog();
    const viewport = useViewport();
    const { t } = useTranslation();
    const { openTableFromSidebar } = useLayout();
    const [filterText, setFilterText] = React.useState('');
    const [showDBML, setShowDBML] = useState(false);
    const [dbmlEditMode, setDbmlEditMode] = useState(false);
    const filterInputRef = React.useRef<HTMLInputElement>(null);

    // Reset filter when toggling DBML view
    const handleToggleDBML = useCallback(() => {
        // If switching to DBML mode for the first time, clear filter
        if (!showDBML) {
            setFilterText('');
        }
        setShowDBML((prev) => !prev);
    }, [showDBML]);

    // Function to toggle edit mode - can be called from child components
    const toggleDbmlEditMode = useCallback(() => {
        if (showDBML) {
            setDbmlEditMode((prev) => !prev);
            // Clear filter when entering edit mode
            if (!dbmlEditMode) {
                setFilterText('');
            }
            return true;
        }
        return false;
    }, [showDBML, setDbmlEditMode, dbmlEditMode]);

    // No need to clear filter text when switching to DBML view-only mode
    // We'll only clear it when entering edit mode (handled in toggleDbmlEditMode)

    const filteredTables = useMemo(() => {
        const filterTableName: (table: DBTable) => boolean = (table) =>
            !filterText?.trim?.() ||
            table.name.toLowerCase().includes(filterText.toLowerCase());

        const filterSchema: (table: DBTable) => boolean = (table) =>
            shouldShowTablesBySchemaFilter(table, filteredSchemas);

        return tables.filter(filterSchema).filter(filterTableName);
    }, [tables, filterText, filteredSchemas]);

    const createTableWithLocation = useCallback(
        async (schema?: string) => {
            const padding = 80;
            const centerX =
                -viewport.x / viewport.zoom + padding / viewport.zoom;
            const centerY =
                -viewport.y / viewport.zoom + padding / viewport.zoom;
            const table = await createTable({
                x: centerX,
                y: centerY,
                schema,
            });
            openTableFromSidebar(table.id);
        },
        [
            createTable,
            openTableFromSidebar,
            viewport.x,
            viewport.y,
            viewport.zoom,
        ]
    );

    const handleCreateTable = useCallback(async () => {
        setFilterText('');

        if ((filteredSchemas?.length ?? 0) > 1) {
            openTableSchemaDialog({
                onConfirm: createTableWithLocation,
                schemas: schemas.filter((schema) =>
                    filteredSchemas?.includes(schema.id)
                ),
            });
        } else {
            const schema =
                filteredSchemas?.length === 1
                    ? schemas.find((s) => s.id === filteredSchemas[0])?.name
                    : undefined;
            createTableWithLocation(schema);
        }
    }, [
        createTableWithLocation,
        filteredSchemas,
        openTableSchemaDialog,
        schemas,
        setFilterText,
    ]);

    const handleClearFilter = useCallback(() => {
        setFilterText('');
    }, []);

    const operatingSystem = useMemo(() => getOperatingSystem(), []);

    useHotkeys(
        operatingSystem === 'mac' ? 'meta+f' : 'ctrl+f',
        () => {
            filterInputRef.current?.focus();
        },
        {
            preventDefault: true,
        },
        [filterInputRef]
    );

    useHotkeys(
        operatingSystem === 'mac' ? 'meta+p' : 'ctrl+p',
        () => {
            handleToggleDBML();
        },
        {
            preventDefault: true,
        },
        [handleToggleDBML]
    );

    useHotkeys(
        operatingSystem === 'mac' ? 'meta+e' : 'ctrl+e',
        () => {
            if (showDBML) {
                setDbmlEditMode((value) => !value);
            }
        },
        {
            preventDefault: true,
        },
        [showDBML, setDbmlEditMode]
    );

    // Reset edit mode when toggling DBML view off
    useEffect(() => {
        if (!showDBML) {
            setDbmlEditMode(false);
        }
    }, [showDBML]);

    return (
        <section
            className="flex flex-1 flex-col overflow-hidden px-2"
            data-vaul-no-drag
        >
            <div className="flex items-center justify-between gap-4 py-1">
                <div className="flex items-center gap-1">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span>
                                <Button
                                    variant="ghost"
                                    className="size-8 p-0"
                                    onClick={handleToggleDBML}
                                >
                                    {showDBML ? (
                                        <List className="size-4" />
                                    ) : (
                                        <Code className="size-4" />
                                    )}
                                </Button>
                            </span>
                        </TooltipTrigger>
                        <TooltipContent>
                            {showDBML
                                ? t('side_panel.tables_section.show_list')
                                : t('side_panel.tables_section.show_dbml')}
                            {operatingSystem === 'mac' ? ' (⌘P)' : ' (Ctrl+P)'}
                        </TooltipContent>
                    </Tooltip>

                    {showDBML && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span>
                                    <Button
                                        variant="ghost"
                                        className="size-8 p-0"
                                        onClick={() =>
                                            setDbmlEditMode((value) => !value)
                                        }
                                    >
                                        {dbmlEditMode ? (
                                            <Eye className="size-4" />
                                        ) : (
                                            <Edit className="size-4" />
                                        )}
                                    </Button>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent>
                                {dbmlEditMode
                                    ? t('side_panel.tables_section.view_mode')
                                    : t('side_panel.tables_section.edit_mode')}
                                {operatingSystem === 'mac'
                                    ? ' (⌘E)'
                                    : ' (Ctrl+E)'}
                            </TooltipContent>
                        </Tooltip>
                    )}
                </div>

                {/* Show filter input when not in DBML edit mode */}
                {!dbmlEditMode ? (
                    <div className="flex-1">
                        <Input
                            ref={filterInputRef}
                            type="text"
                            placeholder={t('side_panel.tables_section.filter')}
                            className="h-8 w-full focus-visible:ring-0"
                            value={filterText}
                            onChange={(e) => setFilterText(e.target.value)}
                        />
                    </div>
                ) : (
                    <div className="flex flex-1 items-center justify-center">
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            {t('side_panel.tables_section.edit_mode')}
                        </div>
                    </div>
                )}

                <Button
                    variant="secondary"
                    className="h-8 p-2 text-xs"
                    onClick={handleCreateTable}
                >
                    <Table className="h-4" />
                    {t('side_panel.tables_section.add_table')}
                </Button>
            </div>
            <div className="flex flex-1 flex-col overflow-hidden">
                {showDBML ? (
                    dbmlEditMode ? (
                        <EditorTableDBML
                            filteredTables={filteredTables}
                            toggleEditMode={toggleDbmlEditMode}
                        />
                    ) : (
                        <TableDBML
                            filteredTables={filteredTables}
                            toggleEditMode={toggleDbmlEditMode}
                        />
                    )
                ) : (
                    <ScrollArea className="h-full">
                        {tables.length === 0 ? (
                            <EmptyState
                                title={t(
                                    'side_panel.tables_section.empty_state.title'
                                )}
                                description={t(
                                    'side_panel.tables_section.empty_state.description'
                                )}
                                className="mt-20"
                            />
                        ) : filterText && filteredTables.length === 0 ? (
                            <div className="mt-10 flex flex-col items-center gap-2">
                                <div className="text-sm text-muted-foreground">
                                    {t('side_panel.tables_section.no_results')}
                                </div>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={handleClearFilter}
                                    className="gap-1"
                                >
                                    <X className="size-3.5" />
                                    {t('side_panel.tables_section.clear')}
                                </Button>
                            </div>
                        ) : (
                            <TableList tables={filteredTables} />
                        )}
                    </ScrollArea>
                )}
            </div>
        </section>
    );
};
