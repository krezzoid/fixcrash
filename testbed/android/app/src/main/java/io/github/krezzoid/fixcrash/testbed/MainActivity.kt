package io.github.krezzoid.fixcrash.testbed

import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.fragment.app.commit
import com.google.firebase.analytics.FirebaseAnalytics
import com.google.firebase.crashlytics.FirebaseCrashlytics
import io.github.krezzoid.fixcrash.testbed.details.DetailsFragment
import io.github.krezzoid.fixcrash.testbed.feed.FeedPager
import io.github.krezzoid.fixcrash.testbed.profile.ProfileParser

class MainActivity : AppCompatActivity() {

    private val crashlytics by lazy { FirebaseCrashlytics.getInstance() }
    private val analytics by lazy { FirebaseAnalytics.getInstance(this) }
    private val feedPager = FeedPager(FakeBackend.feed)
    private var nextPage = 0
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContentView(R.layout.activity_main)
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.main)) { v, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom)
            insets
        }

        crashlytics.setUserId(SYNTHETIC_USER_ID)
        status = findViewById(R.id.status)
        findViewById<Button>(R.id.open_profile).setOnClickListener { openProfile() }
        findViewById<Button>(R.id.load_more).setOnClickListener { loadMore() }
        findViewById<Button>(R.id.open_details).setOnClickListener { openDetails() }

        val scenario = intent.getStringExtra(EXTRA_SCENARIO)
        if (savedInstanceState == null && scenario != null) {
            // After onCreate, so a crash surfaces as it would from a tap, not wrapped
            // in "Unable to start activity".
            status.post { runScenario(scenario) }
        }
    }

    private fun openProfile() {
        track("open_profile")
        val profile = ProfileParser().parse(FakeBackend.PROFILE_JSON)
        status.text = getString(R.string.profile_loaded, profile.displayName)
    }

    private fun loadMore() {
        if (nextPage >= feedPager.pageCount) {
            status.setText(R.string.feed_end)
            return
        }
        track("load_more")
        crashlytics.setCustomKey("feed_page", nextPage)
        val items = feedPager.page(nextPage)
        nextPage++
        status.text = getString(R.string.feed_loaded, nextPage, items.size)
    }

    private fun openDetails() {
        track("open_details")
        supportFragmentManager.commit {
            replace(R.id.details_container, DetailsFragment())
            addToBackStack(null)
        }
    }

    /** Lets adb drive a scenario: `am start -S -n <app>/.MainActivity --es scenario <name>`. */
    private fun runScenario(name: String) {
        when (name) {
            "parser" -> openProfile()
            "paging" -> repeat(feedPager.pageCount) { loadMore() }
            "lifecycle" -> {
                openDetails()
                // The user goes back before the details have loaded.
                window.decorView.postDelayed({ supportFragmentManager.popBackStack() }, 300)
            }
        }
    }

    private fun track(action: String) {
        crashlytics.log("action: $action")
        crashlytics.setCustomKey("last_action", action)
        analytics.logEvent(action, null)
    }

    private companion object {
        const val EXTRA_SCENARIO = "scenario"
        const val SYNTHETIC_USER_ID = "test-user-0001"
    }
}
