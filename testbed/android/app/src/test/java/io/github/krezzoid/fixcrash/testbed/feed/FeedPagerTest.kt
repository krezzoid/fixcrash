package io.github.krezzoid.fixcrash.testbed.feed

import org.junit.Assert.assertEquals
import org.junit.Test

class FeedPagerTest {

    private fun items(count: Int) = (1..count).map { FeedItem(it, "Post #$it") }

    @Test
    fun countsPartialPage() {
        assertEquals(3, FeedPager(items(23), pageSize = 10).pageCount)
    }

    @Test
    fun returnsFullPage() {
        val page = FeedPager(items(20), pageSize = 10).page(1)

        assertEquals((11..20).toList(), page.map { it.id })
    }
}
