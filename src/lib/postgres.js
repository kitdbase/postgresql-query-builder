import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const POSTGRES_DATABASE = process.env.POSTGRES_DATABASE;
const POSTGRES_USER = process.env.POSTGRES_USER;
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD;
const POSTGRES_HOST = process.env.POSTGRES_HOST;
const POSTGRES_PORT = process.env.POSTGRES_PORT || 5432;

const { Pool } = pg;

class Postgres {
    #pool

    constructor() {
        if (!Postgres.instance) {
            try {
                this.#pool = new Pool({
                    host: POSTGRES_HOST,
                    user: POSTGRES_USER,
                    password: POSTGRES_PASSWORD,
                    database: POSTGRES_DATABASE,
                    port: POSTGRES_PORT,
                });
                Postgres.instance = this;
            } catch (error) {
                console.error('Error al conectar con PostgreSQL:', error);
            }
        }

        return Postgres.instance;
    }

    table(tableName) {
        return new TableQuery(tableName, this.#pool);
    }

    async query(databaseName, sqlQuery) {
        if (typeof databaseName !== 'string' || typeof sqlQuery !== 'string') {
            throw new Error('El nombre de la base de datos y la consulta deben ser cadenas de texto.');
        }

        const sqlCommands = sqlQuery.split(';').filter(cmd => cmd.trim().length > 0);

        try {
            // Cambiar la base de datos mediante una nueva conexión si es necesario
            const tempPool = new Pool({
                host: POSTGRES_HOST,
                user: POSTGRES_USER,
                password: POSTGRES_PASSWORD,
                database: POSTGRES_DATABASE,
                port: POSTGRES_PORT,
            });

            // Ejecutar los comandos SQL uno por uno
            for (const command of sqlCommands) {
                const query = `${command};`; // Asegurarse de incluir el punto y coma
                await tempPool.query(query);
            }

            await tempPool.end(); // Cerrar el pool temporal

            return { success: true };
        } catch (error) {
            console.error('Error al ejecutar la consulta.', error);
            return { error: error.message };
        }
    }
}

class TableQuery {
    #conection;
    #nextType; // Almacenar el tipo para la próxima condición
    #joins; // Almacenar los JOINs
    #orderBy; // Almacenar los ORDER BY
    #distinct;
    #groupBy; // Almacenar los GROUP BY

    constructor(tableName, conection = null) {
        this.tableName = tableName;
        this.fields = [];
        this.#nextType = 'AND';
        this.#joins = [];
        this.query = `SELECT * FROM "${tableName}"`;
        this.conditions = [];
        this.#distinct = false;
        this.#orderBy = [];
        this.#groupBy = [];
        this.#conection = conection;
    }

    columns(){
        return new Columns(this.tableName, this.#conection);
    }
    
    async create(fields) {
        try {
            const fieldsDefinition = fields.map((field) => {
                const { name, type, defaultValue, length, options } = field;

                if (!name || !type) {
                    throw new Error('Cada campo debe tener un nombre y un tipo.');
                }

                let fieldDefinition;
                if (length) {
                    if (Array.isArray(length) && length.length === 2) {
                        const [precision, scale] = length;
                        fieldDefinition = `"${name}" ${type}(${precision}, ${scale})`;
                    } else {
                        fieldDefinition = `"${name}" ${type}(${length})`;
                    }
                } else {
                    fieldDefinition = `"${name}" ${type}`;
                }

                if (defaultValue !== undefined && defaultValue !== null) {
                    fieldDefinition += (['VARCHAR', 'CHAR', 'TEXT'].includes(type.toUpperCase()))
                        ? ` DEFAULT '${defaultValue}'`
                        : ` DEFAULT ${defaultValue}`;
                }

                if (options) {
                    if (options.includes('primary')) {
                        fieldDefinition += ' PRIMARY KEY';
                    }
                    if (options.includes('unique')) {
                        fieldDefinition += ' UNIQUE';
                    }
                }

                return fieldDefinition;
            }).join(', ');

            let sqlQuery = `CREATE TABLE IF NOT EXISTS "${this.tableName}" (${fieldsDefinition}`;

            // Agregar FOREIGN KEYS si las hay
            const foreignKeys = fields
                .filter((field) => field.foreing)
                .map(
                    (field) =>
                        `, FOREIGN KEY ("${field.name}") REFERENCES "${field.foreing.table}"("${field.foreing.column}")`
                )
                .join(' ');

            sqlQuery += foreignKeys + ')';
            
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
        } catch (error) {
            throw error;
            //throw new Error('Error al eliminar la tabla: ' + error.message);
        }
    }
    

    select(fields = []) {
        if (fields.length > 0) {
            this.query = `SELECT ${this.#distinct ? 'DISTINCT ' : ''}${fields.join(', ')} FROM ${this.tableName}`;
        }
        return this;
    }

    where(column, operator, value) {
        this.conditions.push({ column, operator, value, type: this.#nextType, isGroup: false });
        this.#nextType = 'AND'; // Reiniciar el tipo después de agregar una condición
        return this;
    }

    orWhere(column, operator, value) {
        this.conditions.push({ column, operator, value, type: 'OR', isGroup: false });
        return this;
    }

    whereGroup(callback) {
        const groupQuery = new TableQuery(this.tableName);
        callback(groupQuery);
        const groupConditions = groupQuery.buildConditions(); // Construir solo las condiciones sin SELECT ni WHERE
        this.conditions.push({ query: groupConditions, type: this.#nextType, isGroup: true });
        this.#nextType = 'AND'; // Reiniciar el tipo después de agregar un grupo
        return this;
    }
    
    or() {
        this.#nextType = 'OR';
        return this;
    }

    and() {
        this.#nextType = 'AND';
        return this;
    }

    whereBetween(column, [value1, value2]) {
        if (Array.isArray([value1, value2]) && value1 !== undefined && value2 !== undefined) {
            this.conditions.push({ column, operator: 'BETWEEN', value: [value1, value2], type: this.#nextType, isGroup: false });
            this.#nextType = 'AND'; // Reiniciar el tipo después de agregar una condición
        }
        return this;
    }

    whereIn(column, values) {
        if (Array.isArray(values) && values.length > 0) {
            this.conditions.push({ column, operator: 'IN', value: values, type: this.#nextType, isGroup: false });
            this.#nextType = 'AND'; // Reiniciar el tipo después de agregar una condición
        }
        return this;
    }

    whereNull(column) {
        this.conditions.push({ column, operator: 'IS NULL', type: this.#nextType, isGroup: false });
        this.#nextType = 'AND'; // Reiniciar el tipo después de agregar una condición
        return this;
    }

    whereNotNull(column) {
        this.conditions.push({ column, operator: 'IS NOT NULL', type: this.#nextType, isGroup: false });
        this.#nextType = 'AND'; // Reiniciar el tipo después de agregar una condición
        return this;
    }

    buildQuery(includeSelect = true) {
        let query = includeSelect ? this.query : ''; // Si se incluye el SELECT o no

        // Añadir JOINs
        if (this.#joins.length > 0) {
            query += ` ${this.#joins.join(' ')}`;
        }

        const whereClauses = this.buildConditions();

        if (whereClauses.length > 0) {
            query += ` WHERE ${whereClauses}`;
        }

        // Añadir GROUP BY
        if (this.#groupBy.length > 0) {
            query += ` GROUP BY ${this.#groupBy.join(', ')}`;
        }

        if (this.limitValue !== null && this.limitValue !== undefined && !Number.isNaN(this.limitValue)) {
            query += ` LIMIT ${this.limitValue}`;
          }
      
          if (this.pageValue !== null && this.pageValue !== undefined && !Number.isNaN(this.pageValue)) {
            const offset = (this.pageValue - 1) * this.limitValue;
            query += ` OFFSET ${offset}`;
          }

        // Añadir ORDER BY solo si no es una consulta agregada (como COUNT, SUM, etc.)
        if (this.#orderBy.length > 0 && !this.query.startsWith('SELECT COUNT') && !this.query.startsWith('SELECT SUM') && !this.query.startsWith('SELECT AVG') && !this.query.startsWith('SELECT MAX') && !this.query.startsWith('SELECT MIN')) {
            const orderByClauses = this.#orderBy
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
                  const values = cond.value.map(val => typeof val === 'string' ? `'${val}'` : val).join(', ');
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

    join(table, column1, operator, column2) {
        this.#joins.push(`JOIN ${table} ON ${column1} ${operator} ${column2}`);
        return this;
    }

    leftJoin(table, column1, operator, column2) {
        this.#joins.push(`LEFT JOIN ${table} ON ${column1} ${operator} ${column2}`);
        return this;
    }

    rightJoin(table, column1, operator, column2) {
        this.#joins.push(`RIGHT JOIN ${table} ON ${column1} ${operator} ${column2}`);
        return this;
    }

    orderBy(column, direction = 'ASC') {
      const validDirections = ['ASC', 'DESC'];
      if (validDirections.includes(direction.toUpperCase())) {
          this.#orderBy.push({ column, direction: direction.toUpperCase() });
      } else {
          throw new Error(`Invalid direction: ${direction}. Use 'ASC' or 'DESC'.`);
      }
      return this;
    }

    groupBy(column) {
        this.#groupBy.push(column);
        return this;
    }

    distinct() {
      this.#distinct = true;
      this.query = this.query.replace(/^SELECT /, 'SELECT DISTINCT '); // Cambia SELECT a SELECT DISTINCT si ya se ha establecido DISTINCT
      return this;
    }

    count(column = '*') {
        this.query = `SELECT COUNT(${column}) AS count FROM ${this.tableName}`;
        return this;
    }

    sum(column) {
        this.query = `SELECT SUM(${column}) AS sum FROM ${this.tableName}`;
        return this;
    }

    avg(column) {
        this.query = `SELECT AVG(${column}) AS avg FROM ${this.tableName}`;
        return this;
    }

    max(column) {
        this.query = `SELECT MAX(${column}) AS max FROM ${this.tableName}`;
        return this;
    }

    min(column) {
        this.query = `SELECT MIN(${column}) AS min FROM ${this.tableName}`;
        return this;
    }

    limit(number) {
        this.limitValue = number;
        return this; 
    }

    page(number) {
        this.pageValue = number;
        return this; 
    }

    async get() {
      const sqlQuery = this.buildQuery();
      try {
          const result = await this.#get_response(sqlQuery);
          return result; // Devuelve todos los resultados
      } catch (error) {
          throw error;
      }
    }

    async first() {
        const sqlQuery = this.buildQuery();
        try {
            const result = await this.#get_response(sqlQuery);
            return result[0] || null; // Devuelve el primer resultado o null si no hay resultados
        } catch (error) {
            //console.error('Error al obtener el primer resultado.', error);
            throw error;
        }
    }

    async find(value, column = 'id') {
        this.where(column, '=', value); // Agregar una condición WHERE
        const sqlQuery = this.buildQuery();
        try {
            const result = await this.#get_response(sqlQuery);
            return result[0] || null; // Devuelve el primer resultado o null si no hay resultados
        } catch (error) {
            //console.error('Error al encontrar el registro.', error);
            throw error;
        }
    }
    
    async insert(data) {
        // Verifica si data NO es un array
        if (!Array.isArray(data)) {
            throw new Error('El método insert requiere un array de objetos con pares clave-valor.');
        }
    
        // Asegúrate de que el array contenga solo objetos
        if (!data.every(item => typeof item === 'object' && item !== null)) {
            throw new Error('El array debe contener solo objetos válidos.');
        }
    
        try {
            const results = [];
    
            for (const row of data) {
                const keys = Object.keys(row).map(key => `${key}`);
                const values = Object.values(row).map(value => {
                    if (value === undefined || value === null) {
                        return 'NULL'; // Maneja valores undefined o null
                    }
                    return typeof value === 'string' ? `'${value}'` : value;
                });
    
                const columns = keys.join(', ');
                const placeholders = values.join(', ');
    
                const sqlQuery = `INSERT INTO ${this.tableName} (${columns}) VALUES (${placeholders})`;
    
                const result = await this.#get_response(sqlQuery);
                const insertedRow = await this.where('id', '=', result.insertId || 0).first();
                results.push(insertedRow);
            }
    
            return results;
        } catch (error) {
            throw new Error('Error al insertar los datos: ' + error.message);
        }
    }

    async update(data) {
      if (typeof data !== 'object' || Array.isArray(data)) {
          throw new Error('El método update requiere un objeto con pares clave-valor.');
      }

      const updates = Object.keys(data).map(key => {
          const value = data[key];
          return `${key} = ${typeof value === 'string' ? `'${value}'` : value}`;
      }).join(', ');

      const whereClauses = this.buildConditions();

      if (whereClauses.length === 0) {
          throw new Error('Debe especificar al menos una condición WHERE para realizar un update.');
      }

      const sqlQuery = `UPDATE ${this.tableName} SET ${updates} WHERE ${whereClauses}`;

      try {
          const result = await this.#get_response(sqlQuery);
          return result;
      } catch (error) {
          //console.error('Error al actualizar los datos.', error);
          throw error;
      }
    }

    async delete() {
        const whereClauses = this.buildConditions();

        if (whereClauses.length === 0) {
            throw new Error('Debe especificar al menos una condición WHERE para realizar un delete.');
        }

        const sqlQuery = `DELETE FROM ${this.tableName} WHERE ${whereClauses}`;

        try {
            const result = await this.#get_response(sqlQuery);
            return result;
        } catch (error) {
            //console.error('Error al eliminar los datos.', error);
            throw error;
        }
    }

    async #get_response(sql) {
        if (!this.#conection) {
            throw new Error("La conexión no está definida.");
        }
   
        try {
            const client = await this.#conection.connect();
            const result = await client.query(sql);
            client.release();
            return result.rows || [];
        } catch (error) {
            // Error específico cuando la base de datos no existe
            if (error.code === '3D000') { 
                try {    
                    await this.#conection.end();
                    this.#conection = new Pool({
                        host: POSTGRES_HOST,
                        user: POSTGRES_USER,
                        password: POSTGRES_PASSWORD,
                        port: POSTGRES_PORT,
                        database: 'postgres' // Base de datos por defecto en PostgreSQL
                    });
                    const client_aux = await this.#conection.connect();    
                    await client_aux.query(`CREATE DATABASE ${POSTGRES_DATABASE};`);
                    await this.#conection.end();
                    this.#conection = new Pool({
                        host: POSTGRES_HOST,
                        user: POSTGRES_USER,
                        password: POSTGRES_PASSWORD,
                        database: POSTGRES_DATABASE,
                        port: POSTGRES_PORT,
                    });
                    const client = await this.#conection.connect();
                    const result = await client.query(sql);
                    client.release();
                    client_aux.release();
                    return result.rows || []; 
                } catch (dbError) {
                    //console.error('Error al crear la base de datos:', dbError.message);
                    throw dbError;
                }
            }
    
            console.error('Error al ejecutar la consulta:', error.message);
            throw error;
        }
    }
}

class Columns {
    #conection;

    constructor(tableName, conection=null) {
        this.tableName = tableName;
        this.#conection = conection; // Inicializar GROUP BY
    }
    async get() {
        try {
            // Verifica si la tabla ya existe
            const tableExistsQuery = `
                SELECT EXISTS (
                    SELECT 1 FROM pg_catalog.pg_tables 
                    WHERE tablename = '${this.tableName}'
                )
            `;
            const tableExistsResult = await this.#get_response(tableExistsQuery);

            if (tableExistsResult[0].exists) {
                const existingFieldsQuery = `
                    SELECT column_name, data_type, column_default, is_nullable
                    FROM information_schema.columns
                    WHERE table_name = '${this.tableName}'
                `;
                const existingFields = await this.#get_response(existingFieldsQuery);
    
                // Mapeamos los campos actuales en un formato más manejable
                return existingFields.reduce((acc, field) => {
                    acc[field.column_name] = {
                        type: field.data_type,
                        defaultValue: field.column_default,
                        key: field.is_nullable === 'NO' ? 'PRI' : null // Assuming only primary keys marked as 'NO'
                    };
                    return acc;
                }, {});
            } else {
                return {}; // La tabla no existe
            }
        } catch (error) {
            throw error;
        }
    }
    
    async add(fields) {
        try {
            const currentFields = await this.get();
    
            for (const field of fields) {
                const { name, type, length, defaultValue, options, foreing } = field;
                const fullType = (length && type !== "TEXT") ? `${type}(${length})` : type;
    
                if (!currentFields[name]) {
                    // El campo no existe, agregamos una nueva columna
                    let alterQuery = `ALTER TABLE ${this.tableName} ADD COLUMN ${name} ${fullType}`;
                    
                    if (defaultValue) {
                        alterQuery += (['varchar', 'character', 'text', 'enum', 'set'].includes(type)) 
                            ? (defaultValue ? ` DEFAULT '${defaultValue}'` : ` DEFAULT NULL`)
                            : (defaultValue === 'NONE' || defaultValue === null) 
                                ? ''
                                : (defaultValue ? ` DEFAULT ${defaultValue}` : ` DEFAULT NULL`);
                    }
            
                    if (options) {
                        if (options.includes('primary')) {
                            alterQuery += ' PRIMARY KEY';
                        }
                        if (options.includes('unique')) {
                            alterQuery += ' UNIQUE';
                        }
                    }
            
                    if (foreing) {
                        alterQuery += `, ADD CONSTRAINT fk_${name} FOREIGN KEY (${name}) REFERENCES ${foreing.table}(${foreing.column})`;
                    }
            
                    await this.#get_response(alterQuery);
                }
            }
    
            return true;
        } catch (error) {
            console.error('Error al agregar columnas.', error);
            throw error;
        }
    }
    
    async edit(fields) {
        try {
            const currentFields = await this.get();
    
            for (const field of fields) {
                const { name, type, length, defaultValue, options, foreing } = field;
                const fullType = (length && type !== "TEXT") ? `${type}(${length})` : type;
    
                if (currentFields[name]) {
                    const existingField = currentFields[name];
    
                    if (existingField.type !== fullType || existingField.defaultValue !== defaultValue ||
                        (options && options.includes('unique') && existingField.key !== 'UNI') ||
                        (options && options.includes('primary') && existingField.key !== 'PRI')) {
    
                            // Modificamos la columna existente
                            let modifyQuery = existingField.type !== fullType ? `ALTER TABLE ${this.tableName} ALTER COLUMN ${name} TYPE ${fullType};\n ALTER TABLE ${this.tableName} ALTER COLUMN ${name}` : `ALTER TABLE ${this.tableName} ALTER COLUMN ${name}`;
                    
                            if (existingField.defaultValue !== defaultValue) {

                                if (['varchar', 'character', 'text', 'enum', 'set'].includes(type)) {
                                    modifyQuery += defaultValue ? ` SET DEFAULT '${defaultValue}';` : ` DROP DEFAULT;`;
                                } else {
                                    modifyQuery += (defaultValue === 'NONE' || defaultValue === null)
                                        ? ` DROP DEFAULT;`
                                        : defaultValue
                                            ? ` SET DEFAULT ${defaultValue};`
                                            : ` DROP DEFAULT;`;
                                }
                            
                
                                if (options) {
                                    if (options.includes('primary')) {
                                        modifyQuery += ' ADD PRIMARY KEY';
                                    }
                                    if (options.includes('unique')) {
                                        modifyQuery += ' ADD UNIQUE';
                                    }
                                }
                    
                                if (foreing) {
                                    modifyQuery += `, ADD CONSTRAINT fk_${name} FOREIGN KEY (${name}) REFERENCES ${foreing.table}(${foreing.column})`;
                                }

                        } else {
                            modifyQuery += `ALTER TABLE ${this.tableName} ALTER COLUMN \`${name}\``;
    
                            if (existingField.defaultValue !== defaultValue) {
                                if (['varchar', 'character', 'text', 'enum', 'set'].includes(type)) {
                                    modifyQuery += defaultValue ? ` SET DEFAULT '${defaultValue}';` : ` DROP DEFAULT;`;
                                } else {
                                    modifyQuery += (defaultValue === 'NONE' || defaultValue === null)
                                        ? ` DROP DEFAULT;`
                                        : defaultValue
                                            ? ` SET DEFAULT ${defaultValue};`
                                            : ` DROP DEFAULT;`;
                                }
                            }
    
                            if (options) {
                                if (options.includes('primary')) {
                                    modifyQuery += ' ADD PRIMARY KEY';
                                }
                                if (options.includes('autoincrement')) {
                                    modifyQuery += ' ADD AUTOINCREMENT';
                                }
                                if (options.includes('unique')) {
                                    modifyQuery += ' ADD UNIQUE';
                                }
                            }
    
                            if (foreing) {
                                modifyQuery += `, ADD CONSTRAINT fk_${name} FOREIGN KEY (${name}) REFERENCES ${foreing.table}(${foreing.column})`;
                            }
                        }
                        

                        await this.#get_response(modifyQuery);
                    }
                }
            }
    
            return true;
        } catch (error) {
            console.error('Error al editar columnas.', error);
            throw error;
        }
    }

    async delete(fields) {
        try {
            const currentFields = await this.get();
    
            for (const name of fields) {
                if (currentFields[name]) {
                    // Eliminar columna existente
                    let dropQuery = `ALTER TABLE ${this.tableName} DROP COLUMN \`${name}\`;`;
                    await this.#get_response(dropQuery);
                }
            }
    
            return true;
        } catch (error) {
            //console.error('Error al eliminar columnas.', error);
            throw error;
        }
    }

    async #get_response(sql) {
        if (!this.#conection) {
            throw new Error("La conexión no está definida.");
        }
   
        try {
            const client = await this.#conection.connect();
            const result = await client.query(sql);
            client.release();
            return result.rows || [];
        } catch (error) {
            // Error específico cuando la base de datos no existe
            if (error.code === '3D000') { 
                try {    
                    await this.#conection.end();
                    this.#conection = new Pool({
                        host: POSTGRES_HOST,
                        user: POSTGRES_USER,
                        password: POSTGRES_PASSWORD,
                        port: POSTGRES_PORT,
                        database: 'postgres' // Base de datos por defecto en PostgreSQL
                    });
                    const client_aux = await this.#conection.connect();    
                    await client_aux.query(`CREATE DATABASE ${POSTGRES_DATABASE};`);
                    await this.#conection.end();
                    this.#conection = new Pool({
                        host: POSTGRES_HOST,
                        user: POSTGRES_USER,
                        password: POSTGRES_PASSWORD,
                        database: POSTGRES_DATABASE,
                        port: POSTGRES_PORT,
                    });
                    const client = await this.#conection.connect();
                    const result = await client.query(sql);
                    client.release();
                    client_aux.release();
                    return result.rows || []; 
                } catch (dbError) {
                    //console.error('Error al crear la base de datos:', dbError.message);
                    throw dbError;
                }
            }
    
            console.error('Error al ejecutar la consulta:', error.message);
            throw error;
        }
    }
}


const db = new Postgres();
export default db;