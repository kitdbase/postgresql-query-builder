import dotenv from 'dotenv';
import pg from 'pg';
import { Condition, Field, OrderBy } from '../@types/Field.js';

dotenv.config();

const POSTGRES_DATABASE = process.env.POSTGRES_DATABASE;
const POSTGRES_USER = process.env.POSTGRES_USER;
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD;
const POSTGRES_HOST = process.env.POSTGRES_HOST;
const POSTGRES_PORT = process.env.POSTGRES_PORT || 5432;

const { Pool } = pg;

/**
 * Clase principal para manejar conexiones y consultas a la base de datos PostgreSQL.
 * Implementa el patrón Singleton para asegurar una única instancia del pool de conexiones.
 */
class Postgres {
    private static instance: Postgres;
    private pool: pg.Pool | null = null;

    constructor() {
        if (!Postgres.instance) {
            try {
                this.pool = new Pool({
                    host: POSTGRES_HOST,
                    user: POSTGRES_USER,
                    password: POSTGRES_PASSWORD,
                    database: POSTGRES_DATABASE,
                    port: Number(POSTGRES_PORT),
                });
                Postgres.instance = this;
            } catch (error) {
                console.error('Error al conectar con PostgreSQL:', error);
            }
        }
  
        return Postgres.instance;
    }

    /**
     * Crea y devuelve una nueva instancia de `TableQuery` para la tabla especificada.
     * Este método se utiliza para comenzar a construir consultas para una tabla específica.
     * 
     * @param {string} tableName - El nombre de la tabla a consultar.
     * @returns {TableQuery} - Devuelve una nueva instancia de `TableQuery` para la tabla especificada.
     * 
     * @example
     * const usersTable = db.table('users');
     * const users = await usersTable.select(['id', 'name']).get();
     * console.log(users); // [{ id: 1, name: 'John' }, { id: 2, name: 'Jane' }]
     */
    public table(tableName: string): TableQuery {
        return new TableQuery(tableName, this.pool);
    }

    /**
     * Ejecuta una consulta SQL en la base de datos actual.
     * 
     * @param {string} sqlQuery - La consulta SQL a ejecutar.
     * @returns {Promise<{ status: string, message: string, data: any | null }>} - Devuelve un objeto JSON con el estado, mensaje y datos (si los hay).
     * 
     * @example
     * const result = await db.query('SELECT * FROM users;');
     * console.log(result); 
     * // { status: 'success', message: 'Query executed successfully', data: [{ id: 1, name: 'John' }, { id: 2, name: 'Jane' }] }
     * 
     * @example
     * const result = await db.query('INVALID SQL QUERY;');
     * console.log(result); 
     * // { status: 'error', message: 'SQL syntax error', data: null }
     */
    public async query(sqlQuery: string): Promise<{ status: string, message: string, data: any | null }> {
        // Validar que el parámetro sqlQuery sea una cadena de texto
        if (typeof sqlQuery !== 'string') {
            throw new Error('The SQL query must be a string.');
        }

        // Dividir la consulta en comandos individuales (si hay múltiples comandos separados por ';')
        const sqlCommands = sqlQuery.split(';').filter(cmd => cmd.trim().length > 0);

        try {
            // Verificar si el pool de conexiones está disponible
            if (!this.pool) {
                throw new Error('Database connection pool is not available.');
            }

            // Ejecutar cada comando SQL
            let results = [];
            for (const command of sqlCommands) {
                const query = `${command};`;
                const result = await this.pool.query(query);
                results.push(result.rows);
            }

            // Devolver la respuesta en formato JSON
            return {
                status: 'success',
                message: 'Query executed successfully',
                data: results.length === 1 ? results[0] : results, // Si hay un solo comando, devolver solo ese resultado
            };
        } catch (error: any) {
            // Manejar errores y devolver la respuesta en formato JSON
            return {
                status: 'error',
                message: error.message || 'An error occurred while executing the query.',
                data: null,
            };
        }
    }
}

/**
 * Clase para construir y ejecutar consultas SQL para una tabla específica.
 * Soporta operaciones como SELECT, INSERT, UPDATE, DELETE y más.
 */
class TableQuery {
    private conection: pg.Pool | null;
    private nextType: string;
    private joins: string[];
    private _orderBy: OrderBy[];
    private _distinct: boolean;
    private _groupBy: string[];
    private tableName: string;
    private fields: string[];
    private query: string;
    private conditions: Condition[];
    private limitValue: number | null = null;
    private pageValue: number | null = null;

    constructor(tableName: string, conection: pg.Pool | null = null) {
        this.tableName = tableName;
        this.fields = [];
        this.nextType = 'AND';
        this.joins = [];
        this.query = `SELECT * FROM "${tableName}"`;
        this.conditions = [];
        this._distinct = false;
        this._orderBy = [];
        this._groupBy = [];
        this.conection = conection;
    }

    columns() {
        return new Columns(this.tableName, this.conection);
    }
    
    async create(fields: Field[]) {
        try {
            const fieldsDefinition = fields.map(field => {
                const { name, type, defaultValue, length, options, foreign } = field;
    
                if (!name || !type) {
                    throw new Error('Cada campo debe tener un nombre y un tipo.');
                }
    
                let fieldDefinition = (length && type !== "TEXT") ? `"${name}" ${type}(${length})` : `"${name}" ${type}`;

                if(defaultValue){
                    fieldDefinition += (['VARCHAR', 'CHAR', 'TEXT', 'ENUM', 'SET'].includes(type.toUpperCase())) 
                    ? (defaultValue ? ` DEFAULT '${defaultValue}'` : ` DEFAULT NULL`)
                    : (defaultValue === 'NONE' || defaultValue === null) 
                        ? ''
                        : (defaultValue ? ` DEFAULT ${defaultValue}` : ` DEFAULT NULL`);
                }
    
                // Si tiene opciones adicionales como primary o unique
                if (options) {
                    if (options.includes('primary')) {
                        fieldDefinition += ' PRIMARY KEY';
                    }
                    if (options.includes('unique')) {
                        fieldDefinition += ' UNIQUE';
                    }
                }
    
                // Si es una llave foránea
                if (foreign) {
                    fieldDefinition += `, FOREIGN KEY ("${name}") REFERENCES "${foreign.table}"("${foreign.column}")`;
                }
    
                return fieldDefinition;
            }).join(', ');
    
            let sqlQuery = `CREATE TABLE IF NOT EXISTS "${this.tableName}" (${fieldsDefinition}`;
    
            sqlQuery += ')';
            await this.#get_response(sqlQuery);
            return true;
    
        } catch (error) {
            throw error;
        }
    }

    async drop() {
        try {
            const sqlQuery = `DROP TABLE IF EXISTS "${this.tableName}"`;
            await this.#get_response(sqlQuery);
            return true;
        } catch (error:any) {
            throw new Error('Error al eliminar la tabla: ' + error.message);
        }
    }
    
    /**
     * Especifica las columnas a seleccionar en una consulta SELECT.
     * 
     * @param {string[]} fields - Array de nombres de columnas a seleccionar. Si está vacío, selecciona todas las columnas.
     * @returns {TableQuery} - Devuelve la instancia actual de TableQuery para encadenar métodos.
     * 
     * @example
     * const users = await db.table('users').select(['id', 'name']).get();
     * console.log(users); // [{ id: 1, name: 'John' }, { id: 2, name: 'Jane' }]
     */
    select(fields: string[] = []) {
        if (fields.length > 0) {
            this.query = `SELECT ${this._distinct ? 'DISTINCT ' : ''}${fields.join(', ')} FROM "${this.tableName}"`;
        }
        return this;
    }

    /**
     * Agrega una condición WHERE a la consulta.
     * 
     * @param {string} column - La columna por la que filtrar.
     * @param {string} operator - El operador de comparación (ej., '=', '>', '<').
     * @param {any} value - El valor con el que comparar.
     * @returns {TableQuery} - Devuelve la instancia actual de TableQuery para encadenar métodos.
     * 
     * @example
     * const users = await db.table('users').where('age', '>', 25).get();
     * console.log(users); // [{ id: 1, name: 'John', age: 30 }]
     */
    where(column: string, operator: string | undefined, value: any) {
        if (operator === undefined) {
            operator = "=";
        }
        this.conditions.push({ column, operator, value, type: this.nextType, isGroup: false });
        this.nextType = 'AND';
        return this;
    }

    /**
     * Agrega una condición OR WHERE a la consulta.
     * 
     * @param {string} column - La columna por la que filtrar.
     * @param {string} operator - El operador de comparación (ej., '=', '>', '<').
     * @param {any} value - El valor con el que comparar.
     * @returns {TableQuery} - Devuelve la instancia actual de TableQuery para encadenar métodos.
     * 
     * @example
     * const users = await db.table('users').where('age', '>', 25).orWhere('name', '=', 'Jane').get();
     * console.log(users); // [{ id: 1, name: 'John', age: 30 }, { id: 2, name: 'Jane', age: 25 }]
     */
    orWhere(column: string, operator: string | undefined, value: any) {
        if (operator === undefined) {
            operator = "=";
        }
        this.conditions.push({ column, operator, value, type: 'OR', isGroup: false });
        return this;
    }

    /**
     * Agrega una condición WHERE agrupada a la consulta.
     * 
     * @param {Function} callback - Una función de callback que recibe una nueva instancia de TableQuery para construir las condiciones agrupadas.
     * @returns {TableQuery} - Devuelve la instancia actual de TableQuery para encadenar métodos.
     * 
     * @example
     * const users = await db.table('users').whereGroup(query => {
     *     query.where('age', '>', 25).orWhere('name', '=', 'Jane');
     * }).get();
     * console.log(users); // [{ id: 1, name: 'John', age: 30 }, { id: 2, name: 'Jane', age: 25 }]
     */
    whereGroup(callback:any) {
        const groupQuery = new TableQuery(this.tableName);
        callback(groupQuery);
        const groupConditions = groupQuery.buildConditions(); // Construir solo las condiciones sin SELECT ni WHERE
        this.conditions.push({ query: groupConditions, type: this.nextType, isGroup: true });
        this.nextType = 'AND'; // Reiniciar el tipo después de agregar un grupo
        return this;
    }
    
    or() {
        this.nextType = 'OR';
        return this;
    }

    and() {
        this.nextType = 'AND';
        return this;
    }

    /**
     * Agrega una condición WHERE BETWEEN a la consulta.
     * 
     * @param {string} column - La columna por la que filtrar.
     * @param {Array<any>} values - Un array con dos valores que representan el rango.
     * @returns {TableQuery} - Devuelve la instancia actual de TableQuery para encadenar métodos.
     * 
     * @example
     * const users = await db.table('users').whereBetween('age', [20, 30]).get();
     * console.log(users); // [{ id: 1, name: 'John', age: 30 }, { id: 2, name: 'Jane', age: 25 }]
     */
    whereBetween(column:string, [value1, value2]:any) {
        if (Array.isArray([value1, value2]) && value1 !== undefined && value2 !== undefined) {
            this.conditions.push({ column, operator: 'BETWEEN', value: [value1, value2], type: this.nextType, isGroup: false });
            this.nextType = 'AND'; // Reiniciar el tipo después de agregar una condición
        }
        return this;
    }

    /**
     * Agrega una condición WHERE IN a la consulta.
     * 
     * @param {string} column - La columna por la que filtrar.
     * @param {Array<any>} values - Un array de valores a coincidir.
     * @returns {TableQuery} - Devuelve la instancia actual de TableQuery para encadenar métodos.
     * 
     * @example
     * const users = await db.table('users').whereIn('id', [1, 2]).get();
     * console.log(users); // [{ id: 1, name: 'John' }, { id: 2, name: 'Jane' }]
     */
    whereIn(column:string, values:any) {
        if (Array.isArray(values) && values.length > 0) {
            this.conditions.push({ column, operator: 'IN', value: values, type: this.nextType, isGroup: false });
            this.nextType = 'AND'; // Reiniciar el tipo después de agregar una condición
        }
        return this;
    }

    /**
     * Agrega una condición WHERE IS NULL a la consulta.
     * 
     * @param {string} column - La columna por la que filtrar.
     * @returns {TableQuery} - Devuelve la instancia actual de TableQuery para encadenar métodos.
     * 
     * @example
     * const users = await db.table('users').whereNull('email').get();
     * console.log(users); // [{ id: 3, name: 'Alice', email: null }]
     */
    whereNull(column:string) {
        this.conditions.push({ column, operator: 'IS NULL', type: this.nextType, isGroup: false });
        this.nextType = 'AND'; // Reiniciar el tipo después de agregar una condición
        return this;
    }

    /**
     * Agrega una condición WHERE IS NOT NULL a la consulta.
     * 
     * @param {string} column - La columna por la que filtrar.
     * @returns {TableQuery} - Devuelve la instancia actual de TableQuery para encadenar métodos.
     * 
     * @example
     * const users = await db.table('users').whereNotNull('email').get();
     * console.log(users); // [{ id: 1, name: 'John', email: 'john@example.com' }]
     */
    whereNotNull(column:string) {
        this.conditions.push({ column, operator: 'IS NOT NULL', type: this.nextType, isGroup: false });
        this.nextType = 'AND'; // Reiniciar el tipo después de agregar una condición
        return this;
    }

    buildQuery(includeSelect = true) {
        let query = includeSelect ? this.query : ''; // Si se incluye el SELECT o no

        // Añadir JOINs
        if (this.joins.length > 0) {
            query += ` ${this.joins.join(' ')}`;
        }

        const whereClauses = this.buildConditions();

        if (whereClauses.length > 0) {
            query += ` WHERE ${whereClauses}`;
        }

        // Añadir GROUP BY
        if (this._groupBy.length > 0) {
            query += ` GROUP BY ${this._groupBy.join(', ')}`;
        }

        if (this.limitValue !== null && this.limitValue !== undefined && !Number.isNaN(this.limitValue)) {
            query += ` LIMIT ${this.limitValue}`;
          }
      
          if (this.limitValue && this.pageValue !== null && this.pageValue !== undefined && !Number.isNaN(this.pageValue)) {
            const offset = (this.pageValue - 1) * this.limitValue;
            query += ` OFFSET ${offset}`;
          }

        // Añadir ORDER BY solo si no es una consulta agregada (como COUNT, SUM, etc.)
        if (this._orderBy.length > 0 && !this.query.startsWith('SELECT COUNT') && !this.query.startsWith('SELECT SUM') && !this.query.startsWith('SELECT AVG') && !this.query.startsWith('SELECT MAX') && !this.query.startsWith('SELECT MIN')) {
            const orderByClauses = this._orderBy
                .map(order => `${order.column} ${order.direction}`)
                .join(', ');
            query += ` ORDER BY ${orderByClauses}`;
        }

        return query;
    }

    buildConditions() {
      return this.conditions
          .map((cond, index) => {
              const prefix = index === 0 ? '' : ` ${cond.type} `;
              if (cond.isGroup) {
                  return `${prefix}(${cond.query})`;
              }
              let conditionStr = '';
              if (cond.operator === 'BETWEEN') {
                  const [value1, value2] = cond.value;
                  const formattedValue1 = typeof value1 === 'string' ? `'${value1}'` : value1;
                  const formattedValue2 = typeof value2 === 'string' ? `'${value2}'` : value2;
                  conditionStr = `${cond.column} BETWEEN ${formattedValue1} AND ${formattedValue2}`;
              } else if (cond.operator === 'IN') {
                  const values = cond.value.map((val:any) => typeof val === 'string' ? `'${val}'` : val).join(', ');
                  conditionStr = `${cond.column} IN (${values})`;
              } else if (cond.operator === 'IS NULL') {
                  conditionStr = `${cond.column} IS NULL`;
              } else if (cond.operator === 'IS NOT NULL') {
                  conditionStr = `${cond.column} IS NOT NULL`;
              } else {
                  const value = typeof cond.value === 'string' ? `'${cond.value}'` : cond.value;
                  conditionStr = `${cond.column} ${cond.operator} ${value}`;
              }
              return `${prefix}${conditionStr}`;
          })
          .join('');
    }

    /**
     * Agrega una cláusula JOIN a la consulta.
     * 
     * @param {string} table - La tabla a unir.
     * @param {string} column1 - La columna de la tabla actual.
     * @param {string} operator - El operador de comparación (ej., '=', '>', '<').
     * @param {string} column2 - La columna de la tabla unida.
     * @returns {TableQuery} - Devuelve la instancia actual de TableQuery para encadenar métodos.
     * 
     * @example
     * const users = await db.table('users').join('orders', 'users.id', '=', 'orders.user_id').get();
     * console.log(users); // [{ id: 1, name: 'John', order_id: 101 }]
     */
    join(table: string, column1:string, operator:string, column2:string) {
        this.joins.push(`JOIN "${table}" ON ${column1} ${operator} ${column2}`);
        return this;
    }

    /**
     * Agrega una cláusula LEFT JOIN a la consulta.
     * 
     * @param {string} table - La tabla a unir.
     * @param {string} column1 - La columna de la tabla actual.
     * @param {string} operator - El operador de comparación (ej., '=', '>', '<').
     * @param {string} column2 - La columna de la tabla unida.
     * @returns {TableQuery} - Devuelve la instancia actual de TableQuery para encadenar métodos.
     * 
     * @example
     * const users = await db.table('users').leftJoin('orders', 'users.id', '=', 'orders.user_id').get();
     * console.log(users); // [{ id: 1, name: 'John', order_id: 101 }, { id: 2, name: 'Jane', order_id: null }]
     */
    leftJoin(table: string, column1: string, operator: string, column2: string) {
        this.joins.push(`LEFT JOIN "${table}" ON ${column1} ${operator} ${column2}`);
        return this;
    }

    /**
     * Agrega una cláusula RIGHT JOIN a la consulta.
     * 
     * @param {string} table - La tabla a unir.
     * @param {string} column1 - La columna de la tabla actual.
     * @param {string} operator - El operador de comparación (ej., '=', '>', '<').
     * @param {string} column2 - La columna de la tabla unida.
     * @returns {TableQuery} - Devuelve la instancia actual de TableQuery para encadenar métodos.
     * 
     * @example
     * const users = await db.table('users').rightJoin('orders', 'users.id', '=', 'orders.user_id').get();
     * console.log(users); // [{ id: 1, name: 'John', order_id: 101 }, { id: null, name: null, order_id: 102 }]
     */
    rightJoin(table: string, column1: string, operator: string, column2: string) {
        this.joins.push(`RIGHT JOIN "${table}" ON ${column1} ${operator} ${column2}`);
        return this;
    }

    /**
     * Agrega una cláusula ORDER BY a la consulta.
     * 
     * @param {string} column - La columna por la que ordenar.
     * @param {string} direction - La dirección de ordenamiento ('ASC' o 'DESC').
     * @returns {TableQuery} - Devuelve la instancia actual de TableQuery para encadenar métodos.
     * 
     * @example
     * const users = await db.table('users').orderBy('name', 'ASC').get();
     * console.log(users); // [{ id: 2, name: 'Jane' }, { id: 1, name: 'John' }]
     */
    orderBy(column: string, direction: string = 'ASC') {
      const validDirections = ['ASC', 'DESC'];
      if (validDirections.includes(direction.toUpperCase())) {
          this._orderBy.push({ column, direction: direction.toUpperCase() });
      } else {
          throw new Error(`Invalid direction: ${direction}. Use 'ASC' or 'DESC'.`);
      }
      return this;
    }

    /**
     * Agrega una cláusula GROUP BY a la consulta.
     * 
     * @param {string} column - La columna por la que agrupar.
     * @returns {TableQuery} - Devuelve la instancia actual de TableQuery para encadenar métodos.
     * 
     * @example
     * const users = await db.table('users').groupBy('age').get();
     * console.log(users); // [{ age: 30, count: 1 }, { age: 25, count: 1 }]
     */
    groupBy(column:string) {
        this._groupBy.push(column);
        return this;
    }

    /**
     * Agrega una cláusula DISTINCT a la consulta.
     * 
     * @returns {TableQuery} - Devuelve la instancia actual de TableQuery para encadenar métodos.
     * 
     * @example
     * const users = await db.table('users').distinct().select(['name']).get();
     * console.log(users); // [{ name: 'John' }, { name: 'Jane' }]
     */
    distinct() {
      this._distinct = true;
      this.query = this.query.replace(/^SELECT /, 'SELECT DISTINCT '); // Cambia SELECT a SELECT DISTINCT si ya se ha establecido DISTINCT
      return this;
    }

    /**
     * Agrega una cláusula COUNT a la consulta.
     * 
     * @param {string} column - La columna a contar (por defecto es '*').
     * @returns {TableQuery} - Devuelve la instancia actual de TableQuery para encadenar métodos.
     * 
     * @example
     * const count = await db.table('users').count().first();
     * console.log(count); // { count: 2 }
     */
    count(column = '*') {
        this.query = `SELECT COUNT(${column}) AS count FROM "${this.tableName}"`;
        return this;
    }

    /**
     * Agrega una cláusula SUM a la consulta.
     * 
     * @param {string} column - La columna a sumar.
     * @returns {TableQuery} - Devuelve la instancia actual de TableQuery para encadenar métodos.
     * 
     * @example
     * const totalAge = await db.table('users').sum('age').first();
     * console.log(totalAge); // { sum: 55 }
     */
    sum(column: string) {
        this.query = `SELECT SUM(${column}) AS sum FROM "${this.tableName}"`;
        return this;
    }

    /**
     * Agrega una cláusula AVG a la consulta.
     * 
     * @param {string} column - La columna para calcular el promedio.
     * @returns {TableQuery} - Devuelve la instancia actual de TableQuery para encadenar métodos.
     * 
     * @example
     * const avgAge = await db.table('users').avg('age').first();
     * console.log(avgAge); // { avg: 27.5 }
     */
    avg(column:string) {
        this.query = `SELECT AVG(${column}) AS avg FROM "${this.tableName}"`;
        return this;
    }

    /**
     * Agrega una cláusula MAX a la consulta.
     * 
     * @param {string} column - La columna para encontrar el valor máximo.
     * @returns {TableQuery} - Devuelve la instancia actual de TableQuery para encadenar métodos.
     * 
     * @example
     * const maxAge = await db.table('users').max('age').first();
     * console.log(maxAge); // { max: 30 }
     */
    max(column:string) {
        this.query = `SELECT MAX(${column}) AS max FROM "${this.tableName}"`;
        return this;
    }

    /**
     * Agrega una cláusula MIN a la consulta.
     * 
     * @param {string} column - La columna para encontrar el valor mínimo.
     * @returns {TableQuery} - Devuelve la instancia actual de TableQuery para encadenar métodos.
     * 
     * @example
     * const minAge = await db.table('users').min('age').first();
     * console.log(minAge); // { min: 25 }
     */
    min(column: string) {
        this.query = `SELECT MIN(${column}) AS min FROM "${this.tableName}"`;
        return this;
    }

    /**
     * Agrega una cláusula LIMIT a la consulta.
     * 
     * @param {number} number - El número máximo de filas a devolver.
     * @returns {TableQuery} - Devuelve la instancia actual de TableQuery para encadenar métodos.
     * 
     * @example
     * const users = await db.table('users').limit(1).get();
     * console.log(users); // [{ id: 1, name: 'John', age: 30 }]
     */
    limit(number:number) {
        this.limitValue = number;
        return this; 
    }

    /**
     * Agrega paginación a la consulta usando LIMIT y OFFSET.
     * 
     * @param {number} number - El número de página (comenzando desde 1).
     * @returns {TableQuery} - Devuelve la instancia actual de TableQuery para encadenar métodos.
     * 
     * @example
     * const users = await db.table('users').limit(1).page(2).get();
     * console.log(users); // [{ id: 2, name: 'Jane', age: 25 }]
     */
    page(number:number) {
        this.pageValue = number;
        return this; 
    }

    /**
     * Ejecuta la consulta y devuelve todas las filas coincidentes.
     * 
     * @returns {Promise<Array<Object>>} - Devuelve un array de filas.
     * 
     * @example
     * const users = await db.table('users').get();
     * console.log(users); // [{ id: 1, name: 'John' }, { id: 2, name: 'Jane' }]
     */
    async get() {
      const sqlQuery = this.buildQuery();
      try {
          const result = await this.#get_response(sqlQuery);
          return result; // Devuelve todos los resultados
      } catch (error) {
          throw error;
      }
    }

    /**
     * Ejecuta la consulta y devuelve la primera fila coincidente.
     * 
     * @returns {Promise<Object | null>} - Devuelve la primera fila o null si no hay filas coincidentes.
     * 
     * @example
     * const user = await db.table('users').first();
     * console.log(user); // { id: 1, name: 'John' }
     */
    async first() {
        const sqlQuery = this.buildQuery();
        try {
            const result:any = await this.#get_response(sqlQuery);
            return result[0] || null; // Devuelve el primer resultado o null si no hay resultados
        } catch (error) {
            throw error;
        }
    }

    /**
     * Encuentra una fila por un valor específico de columna.
     * 
     * @param {any} value - El valor a buscar.
     * @param {string} column - La columna en la que buscar (por defecto es 'id').
     * @returns {Promise<Object | null>} - Devuelve la primera fila coincidente o null si no hay filas coincidentes.
     * 
     * @example
     * const user = await db.table('users').find(1);
     * console.log(user); // { id: 1, name: 'John' }
     */
    async find(value:any, column = 'id') {
        this.where(column, '=', value); // Agregar una condición WHERE
        const sqlQuery = this.buildQuery();
        try {
            const result:any = await this.#get_response(sqlQuery);
            return result[0] || null; // Devuelve el primer resultado o null si no hay resultados
        } catch (error) {
            throw error;
        }
    }
    
    /**
     * Inserta una o más filas en la tabla.
     * 
     * @param {Array<Object>} data - Un array de objetos que representan las filas a insertar.
     * @returns {Promise<Array<Object>>} - Devuelve un array de las filas insertadas.
     * 
     * @example
     * const newUsers = await db.table('users').insert([
     *     { name: 'Alice', age: 28 },
     *     { name: 'Bob', age: 32 }
     * ]);
     * console.log(newUsers); // [{ id: 3, name: 'Alice', age: 28 }, { id: 4, name: 'Bob', age: 32 }]
     */
    async insert(data:any) {
        // Verifica si data NO es un array
        if (!Array.isArray(data)) {
            throw new Error('El método insert requiere un array de objetos con pares clave-valor.');
        }
    
        // Asegúrate de que el array contenga solo objetos
        if (!data.every(item => typeof item === 'object' && item !== null)) {
            throw new Error('El array debe contener solo objetos válidos.');
        }
    
        try {
            const results: any = [];
    
            for (const row of data) {
                const keys = Object.keys(row).map(key => `"${key}"`);
                const values = Object.values(row).map(value => {
                    if (value === undefined || value === null) {
                        return 'NULL'; // Maneja valores undefined o null
                    }
                    return typeof value === 'string' ? `'${value}'` : value;
                });
    
                const columns = keys.join(', ');
                const placeholders = values.join(', ');
    
                const sqlQuery = `INSERT INTO "${this.tableName}" (${columns}) VALUES (${placeholders}) RETURNING *`;
    
                const result:any = await this.#get_response(sqlQuery);
                results.push(result[0]);
            }
    
            return results;
        } catch (error:any) {
            throw new Error('Error al insertar los datos: ' + error.message);
        }
    }

    /**
     * Actualiza filas en la tabla basándose en las condiciones definidas.
     * 
     * @param {Object} data - Un objeto con pares clave-valor para actualizar.
     * @returns {Promise<Object>} - Devuelve el resultado de la operación de actualización.
     * 
     * @example
     * const result = await db.table('users').where('id', '=', 1).update({ name: 'John Doe' });
     * console.log(result); // { affectedRows: 1 }
     */
    async update(data:any) {
      if (typeof data !== 'object' || Array.isArray(data)) {
          throw new Error('El método update requiere un objeto con pares clave-valor.');
      }

      const updates = Object.keys(data).map(key => {
          const value = data[key];
          return `"${key}" = ${typeof value === 'string' ? `'${value}'` : value}`;
      }).join(', ');

      const whereClauses = this.buildConditions();

      if (whereClauses.length === 0) {
          throw new Error('Debe especificar al menos una condición WHERE para realizar un update.');
      }

      const sqlQuery = `UPDATE "${this.tableName}" SET ${updates} WHERE ${whereClauses} RETURNING *`;

      try {
          const result = await this.#get_response(sqlQuery);
          return result;
      } catch (error) {
          throw error;
      }
    }

    /**
     * Elimina filas de la tabla basándose en las condiciones definidas.
     * 
     * @returns {Promise<Object>} - Devuelve el resultado de la operación de eliminación.
     * 
     * @example
     * const result = await db.table('users').where('id', '=', 1).delete();
     * console.log(result); // { affectedRows: 1 }
     */
    async delete() {
        const whereClauses = this.buildConditions();

        if (whereClauses.length === 0) {
            throw new Error('Debe especificar al menos una condición WHERE para realizar un delete.');
        }

        const sqlQuery = `DELETE FROM "${this.tableName}" WHERE ${whereClauses} RETURNING *`;

        try {
            const result = await this.#get_response(sqlQuery);
            return result;
        } catch (error) {
            throw error;
        }
    }

    async #get_response(sql:string) {
        if (!this.conection) {
            throw new Error('No se ha establecido una conexión a la base de datos.');
        }
        try {
            const result = await this.conection.query(sql);
            return result.rows;
        } catch (error:any) {
            if (error.code === '3D000') { // Código de error de PostgreSQL para base de datos no existente
                try {
                    if(!this.conection){
                        throw new Error('No se ha establecido una conexión a la base de datos.');
                    }
                    await this.conection.end();
                    this.conection = new Pool({
                        host: POSTGRES_HOST,
                        user: POSTGRES_USER,
                        password: POSTGRES_PASSWORD,
                        port: Number(POSTGRES_PORT),
                    });
                    const client = await this.conection.connect();
                    await client.query(`CREATE DATABASE "${POSTGRES_DATABASE}"`);
                    await this.conection.end();
                    this.conection = new Pool({
                        host: POSTGRES_HOST,
                        user: POSTGRES_USER,
                        password: POSTGRES_PASSWORD,
                        database: POSTGRES_DATABASE,
                        port: Number(POSTGRES_PORT),
                    });
                    const result = await this.conection.query(sql);
                    return result.rows;
                } catch (error) {
                    throw error;
                }
            }
            throw error;
        }
    }
}

/**
 * Clase para gestionar las columnas de una tabla.
 * Permite agregar, editar o eliminar columnas.
 */
class Columns {
    private conection: pg.Pool | null;
    private tableName: string;

    constructor(tableName: string, conection: pg.Pool | null = null) {
        this.tableName = tableName;
        this.conection = conection;
    }

    /**
     * Agrega una nueva columna a la tabla.
     * 
     * @param {Field} field - Un objeto que define la columna a agregar.
     * @returns {Promise<boolean>} - Devuelve true si la operación fue exitosa.
     * 
     * @example
     * await db.table('users').columns().add({ name: 'email', type: 'VARCHAR', length: 255 });
     */
    async add(field: Field) {
        try {
            const { name, type, defaultValue, length, options } = field;

            if (!name || !type) {
                throw new Error('Cada campo debe tener un nombre y un tipo.');
            }

            let fieldDefinition = (length && type !== "TEXT") ? `"${name}" ${type}(${length})` : `"${name}" ${type}`;

            if(defaultValue){
                fieldDefinition += (['VARCHAR', 'CHAR', 'TEXT', 'ENUM', 'SET'].includes(type.toUpperCase())) 
                ? (defaultValue ? ` DEFAULT '${defaultValue}'` : ` DEFAULT NULL`)
                : (defaultValue === 'NONE' || defaultValue === null) 
                    ? ''
                    : (defaultValue ? ` DEFAULT ${defaultValue}` : ` DEFAULT NULL`);
            }

            // Si tiene opciones adicionales como primary o unique
            if (options) {
                if (options.includes('primary')) {
                    fieldDefinition += ' PRIMARY KEY';
                }
                if (options.includes('unique')) {
                    fieldDefinition += ' UNIQUE';
                }
            }

            const sqlQuery = `ALTER TABLE "${this.tableName}" ADD COLUMN ${fieldDefinition}`;
            await this.#get_response(sqlQuery);
            return true;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Edita una columna existente en la tabla.
     * 
     * @param {Field} field - Un objeto que define la columna a editar.
     * @returns {Promise<boolean>} - Devuelve true si la operación fue exitosa.
     * 
     * @example
     * await db.table('users').columns().edit({ name: 'email', type: 'VARCHAR', length: 255 });
     */
    async edit(field: Field) {
        try {
            const { name, type, defaultValue, length, options } = field;

            if (!name || !type) {
                throw new Error('Cada campo debe tener un nombre y un tipo.');
            }

            let fieldDefinition = (length && type !== "TEXT") ? `${type}(${length})` : `${type}`;

            if(defaultValue){
                fieldDefinition += (['VARCHAR', 'CHAR', 'TEXT', 'ENUM', 'SET'].includes(type.toUpperCase())) 
                ? (defaultValue ? ` DEFAULT '${defaultValue}'` : ` DEFAULT NULL`)
                : (defaultValue === 'NONE' || defaultValue === null) 
                    ? ''
                    : (defaultValue ? ` DEFAULT ${defaultValue}` : ` DEFAULT NULL`);
            }

            // Si tiene opciones adicionales como primary o unique
            if (options) {
                if (options.includes('primary')) {
                    fieldDefinition += ' PRIMARY KEY';
                }
                if (options.includes('unique')) {
                    fieldDefinition += ' UNIQUE';
                }
            }

            const sqlQuery = `ALTER TABLE "${this.tableName}" ALTER COLUMN "${name}" TYPE ${fieldDefinition}`;
            await this.#get_response(sqlQuery);
            return true;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Elimina una columna de la tabla.
     * 
     * @param {string} columnName - El nombre de la columna a eliminar.
     * @returns {Promise<boolean>} - Devuelve true si la operación fue exitosa.
     * 
     * @example
     * await db.table('users').columns().drop('email');
     */
    async drop(columnName: string) {
        try {
            const sqlQuery = `ALTER TABLE "${this.tableName}" DROP COLUMN "${columnName}"`;
            await this.#get_response(sqlQuery);
            return true;
        } catch (error) {
            throw error;
        }
    }

    async #get_response(sql: string) {
        if (!this.conection) {
            throw new Error('No se ha establecido una conexión a la base de datos.');
        }
        try {
            const result = await this.conection.query(sql);
            return result.rows;
        } catch (error) {
            throw error;
        }
    }
}

const db = new Postgres();
export default db;