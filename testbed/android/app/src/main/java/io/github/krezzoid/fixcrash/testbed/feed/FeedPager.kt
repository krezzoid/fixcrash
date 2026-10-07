package io.github.krezzoid.fixcrash.testbed.feed

data class FeedItem(val id: Int, val title: String)

class FeedPager(
    private val items: List<FeedItem>,
    private val pageSize: Int = 10,
) {
    val pageCount: Int
        get() = (items.size + pageSize - 1) / pageSize

    fun page(index: Int): List<FeedItem> {
        val from = index * pageSize
        return items.subList(from, from + pageSize)
    }
}
