package io.github.krezzoid.fixcrash.testbed.profile

import com.google.gson.Gson

class ProfileParser(private val gson: Gson = Gson()) {

    fun parse(json: String): Profile {
        val dto = gson.fromJson(json, ProfileDto::class.java)
        return Profile(
            id = dto.id,
            displayName = dto.displayName,
            avatarUrl = dto.avatar.url,
        )
    }
}
