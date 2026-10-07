package io.github.krezzoid.fixcrash.testbed.profile

data class ProfileDto(
    val id: String,
    val displayName: String,
    val avatar: AvatarDto,
)

data class AvatarDto(
    val url: String,
    val width: Int,
    val height: Int,
)
