import { DataSource, DataSourceOptions } from "typeorm";

interface RawResultTableAndColumn {
  table_name: string;
  column_name: string;
  data_type: string | undefined;
  is_nullable: string;
}

export interface SqlDatabaseParams {
  includesTables?: Array<string>;
  ignoreTables?: Array<string>;
  sampleRowsInTableInfo?: number;
}

export interface SqlDatabaseOptionsParams extends SqlDatabaseParams {
  appDataSourceOptions: DataSourceOptions;
}

export interface SqlDatabaseDataSourceParams extends SqlDatabaseParams {
  appDataSource: DataSource;
}

export type SerializedSqlDatabase = SqlDatabaseOptionsParams & {
  _type: string;
};

export interface SqlTable {
  tableName: string;
  columns: SqlColumn[];
}

export interface SqlColumn {
  columnName: string;
  dataType?: string;
  isNullable?: boolean;
}

export const verifyListTablesExistInDatabase = (
  tablesFromDatabase: Array<SqlTable>,
  listTables: Array<string>,
  errorPrefixMsg: string
): void => {
  const onlyTableNames: Array<string> = tablesFromDatabase.map(
    (table: SqlTable) => table.tableName
  );
  if (listTables.length > 0) {
    for (const tableName of listTables) {
      if (!onlyTableNames.includes(tableName)) {
        throw new Error(
          `${errorPrefixMsg} the table ${tableName} was not found in the database`
        );
      }
    }
  }
};

export const verifyIncludeTablesExistInDatabase = (
  tablesFromDatabase: Array<SqlTable>,
  includeTables: Array<string>
): void => {
  verifyListTablesExistInDatabase(
    tablesFromDatabase,
    includeTables,
    "Include tables not found in database:"
  );
};

export const verifyIgnoreTablesExistInDatabase = (
  tablesFromDatabase: Array<SqlTable>,
  ignoreTables: Array<string>
): void => {
  verifyListTablesExistInDatabase(
    tablesFromDatabase,
    ignoreTables,
    "Ignore tables not found in database:"
  );
};

const formatToSqlTable = (
  rawResultsTableAndColumn: Array<RawResultTableAndColumn>
): Array<SqlTable> => {
  const sqlTable: Array<SqlTable> = [];
  for (const oneResult of rawResultsTableAndColumn) {
    const sqlColumn = {
      columnName: oneResult.column_name,
      dataType: oneResult.data_type,
      isNullable: oneResult.is_nullable === "YES",
    };
    const currentTable = sqlTable.find(
      (oneTable) => oneTable.tableName === oneResult.table_name
    );
    if (currentTable) {
      currentTable.columns.push(sqlColumn);
    } else {
      const newTable = {
        tableName: oneResult.table_name,
        columns: [sqlColumn],
      };
      sqlTable.push(newTable);
    }
  }

  return sqlTable;
};

export const getTableAndColumnsName = async (
  appDataSource: DataSource
): Promise<Array<SqlTable>> => {
  let sql;
  if (appDataSource.options.type === "postgres") {
    sql =
      "SELECT\n" +
      "    t.table_name,\n" +
      "    c.*\n" +
      "FROM\n" +
      "    information_schema.tables t\n" +
      "        JOIN information_schema.columns c\n" +
      "             ON t.table_name = c.table_name\n" +
      "WHERE\n" +
      "        t.table_schema = 'public'\n" +
      "ORDER BY\n" +
      "    t.table_name,\n" +
      "    c.ordinal_position;";

    const rep = await appDataSource.query(sql);

    return formatToSqlTable(rep);
  }

  if (appDataSource.options.type === "sqlite") {
    sql =
      "SELECT \n" +
      "   m.name AS table_name,\n" +
      "   p.name AS column_name,\n" +
      "   p.type AS data_type,\n" +
      "   CASE \n" +
      "      WHEN p.\"notnull\" = 0 THEN 'YES' \n" +
      "      ELSE 'NO' \n" +
      "   END AS is_nullable \n" +
      "FROM \n" +
      "   sqlite_master m \n" +
      "JOIN \n" +
      "   pragma_table_info(m.name) p \n" +
      "WHERE \n" +
      "   m.type = 'table' AND \n" +
      "   m.name NOT LIKE 'sqlite_%';\n";

    const rep = await appDataSource.query(sql);

    return formatToSqlTable(rep);
  }

  if (appDataSource.options.type === "mysql") {
    sql =
      "SELECT " +
      "TABLE_NAME AS table_name, " +
      "COLUMN_NAME AS column_name, " +
      "DATA_TYPE AS data_type, " +
      "IS_NULLABLE AS is_nullable " +
      "FROM INFORMATION_SCHEMA.COLUMNS " +
      `WHERE TABLE_SCHEMA = '${appDataSource.options.database}';`;

    const rep = await appDataSource.query(sql);

    return formatToSqlTable(rep);
  }

  throw new Error("Database type not implemented yet");
};

const formatSqlResponseToSimpleTableString = (rawResult: unknown): string => {
  if (!rawResult || !Array.isArray(rawResult) || rawResult.length === 0) {
    return "";
  }

  let globalString = "";
  for (const oneRow of rawResult) {
    globalString += `${Object.values(oneRow).reduce(
      (completeString, columnValue) => `${completeString} ${columnValue}`,
      ""
    )}\n`;
  }

  return globalString;
};

export const generateTableInfoFromTables = async (
  tables: Array<SqlTable> | undefined,
  appDataSource: DataSource,
  nbSampleRow: number
): Promise<string> => {
  if (!tables) {
    return "";
  }

  let globalString = "";
  for (const currentTable of tables) {
    // Add the creation of the table in SQL
    let sqlCreateTableQuery = `CREATE TABLE ${currentTable.tableName} (\n`;
    for (const [key, currentColumn] of currentTable.columns.entries()) {
      if (key > 0) {
        sqlCreateTableQuery += ", ";
      }
      sqlCreateTableQuery += `${currentColumn.columnName} ${
        currentColumn.dataType
      } ${currentColumn.isNullable ? "" : "NOT NULL"}`;
    }
    sqlCreateTableQuery += ") \n";

    let sqlSelectInfoQuery;
    if (appDataSource.options.type === "mysql") {
      // We use backticks to quote the table names and thus allow for example spaces in table names
      sqlSelectInfoQuery = `SELECT * FROM \`${currentTable.tableName}\` LIMIT ${nbSampleRow};\n`;
    } else {
      sqlSelectInfoQuery = `SELECT * FROM "${currentTable.tableName}" LIMIT ${nbSampleRow};\n`;
    }

    const columnNamesConcatString = `${currentTable.columns.reduce(
      (completeString, column) => `${completeString} ${column.columnName}`,
      ""
    )}\n`;

    let sample = "";
    try {
      const infoObjectResult = await appDataSource.query(sqlSelectInfoQuery);
      sample = formatSqlResponseToSimpleTableString(infoObjectResult);
    } catch (error) {
      // If the request fails we catch it and only display a log message
      console.log(error);
    }

    globalString = globalString.concat(
      sqlCreateTableQuery +
        sqlSelectInfoQuery +
        columnNamesConcatString +
        sample
    );
  }

  return globalString;
};
