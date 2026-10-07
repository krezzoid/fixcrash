package io.github.krezzoid.fixcrash.testbed

import io.github.krezzoid.fixcrash.testbed.feed.FeedItem

/** Canned responses in place of a network backend. All values are synthetic. */
object FakeBackend {

    const val PROFILE_JSON = """{"id":"user-0001","displayName":"Test User"}"""

    val feed: List<FeedItem> = (1..23).map { FeedItem(id = it, title = "Post #$it") }
}
