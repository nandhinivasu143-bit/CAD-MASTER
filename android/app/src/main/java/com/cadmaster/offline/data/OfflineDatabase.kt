package com.cadmaster.offline.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "user_settings")
data class UserSettingsEntity(
    @PrimaryKey val id: Int = 1,
    val preferredUnitCode: String = "MM",
    val precision: Int = 2,
    val gridVisible: Boolean = true,
    val osnapEnabled: Boolean = true,
    val snapRadiusPx: Float = 44f,
    val osnapModesCsv: String = "ENDPOINT,MIDPOINT,CENTER,INTERSECTION,NEAREST,PERPENDICULAR,TANGENT,QUADRANT",
    val darkBackground: Boolean = true
)

@Entity(tableName = "recent_files")
data class RecentFileEntity(
    @PrimaryKey val uriString: String,
    val displayName: String,
    val format: String,
    val versionLabel: String,
    val unitCode: String,
    val entityCount: Int,
    val openedAtEpochMs: Long
)

@Dao
interface CadDao {
    @Query("SELECT * FROM user_settings WHERE id = 1")
    suspend fun getSettings(): UserSettingsEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveSettings(settings: UserSettingsEntity)

    @Query("SELECT * FROM recent_files ORDER BY openedAtEpochMs DESC LIMIT 20")
    fun observeRecentFiles(): Flow<List<RecentFileEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertRecentFile(file: RecentFileEntity)

    @Query("DELETE FROM recent_files WHERE uriString = :uri")
    suspend fun deleteRecentFile(uri: String)
}

@Database(
    entities = [
        UserSettingsEntity::class,
        RecentFileEntity::class
    ],
    version = 2,
    exportSchema = false
)
abstract class CadRoomDatabase : RoomDatabase() {
    abstract fun cadDao(): CadDao

    companion object {
        @Volatile
        private var INSTANCE: CadRoomDatabase? = null

        fun getInstance(context: Context): CadRoomDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    CadRoomDatabase::class.java,
                    "cad_master_offline.db"
                ).fallbackToDestructiveMigration().build().also { INSTANCE = it }
            }
        }
    }
}
