
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, onSnapshot } from 'firebase/firestore';

// Define global variables for Firebase configuration and app ID
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// Initialize Firebase App and Services
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Main App Component
const App = () => {
  // State variables for authentication and user data
  const [userId, setUserId] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);

  // State variables for video player
  const videoRef = useRef(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [currentVideoTime, setCurrentVideoTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  // State variables for progress tracking
  const [watchedIntervals, setWatchedIntervals] = useState([]); // Array of {start, end} objects
  const [progressPercentage, setProgressPercentage] = useState(0);
  const [lastWatchedPosition, setLastWatchedPosition] = useState(0);

  // Variables to track the current segment being watched (not part of state for performance)
  const currentSegmentStart = useRef(0);
  const lastTimeUpdate = useRef(0);
  const isSeeking = useRef(false);

  // Video ID (can be dynamic based on the lecture)
  const videoId = 'lecture-101'; // Static for this example, could be passed as prop

  // --- Firebase Authentication and Initialization ---
  useEffect(() => {
    // Sign in to Firebase using custom token or anonymously
    const initializeFirebase = async () => {
      try {
        if (initialAuthToken) {
          await signInWithCustomToken(auth, initialAuthToken);
        } else {
          await signInAnonymously(auth);
        }
      } catch (error) {
        console.error("Firebase authentication failed:", error);
        // If authentication fails, set userId to null to prevent Firestore calls
        setUserId(null);
        setIsAuthReady(true); // Still mark auth as ready, but with no user
        return;
      }
    };

    // Listen for auth state changes to get the user ID
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        setUserId(user.uid);
        console.log("Authenticated user ID:", user.uid); // Log for debugging
      } else {
        setUserId(null); // Explicitly set to null if no user is authenticated
        console.log("No user authenticated."); // Log for debugging
      }
      setIsAuthReady(true); // Auth state has been determined
    });

    initializeFirebase();

    // Cleanup auth listener on component unmount
    return () => unsubscribe();
  }, []); // Run only once on component mount

  // --- Firestore Data Management ---

  // Function to save progress to Firestore
  const saveProgress = useCallback(async () => {
    // Only proceed if userId is available (meaning authentication was successful)
    if (!userId) {
      console.log("User not authenticated, cannot save progress.");
      return;
    }

    const videoProgressRef = doc(db, `artifacts/${appId}/users/${userId}/videoProgress`, videoId);
    try {
      await setDoc(videoProgressRef, {
        watchedIntervals: watchedIntervals,
        lastWatchedPosition: currentVideoTime,
        timestamp: Date.now() // Add a timestamp for tracking
      }, { merge: true }); // Use merge to update existing fields without overwriting the whole document
      console.log("Progress saved successfully!");
    } catch (error) {
      console.error("Error saving progress:", error);
    }
  }, [userId, watchedIntervals, currentVideoTime, videoId]);

  // Effect to load progress when auth is ready and userId is set
  useEffect(() => {
    let unsubscribeFromSnapshot; // Declare unsubscribe variable here
    // Only proceed if auth is ready and userId is available
    if (isAuthReady && userId) {
      const videoProgressRef = doc(db, `artifacts/${appId}/users/${userId}/videoProgress`, videoId);
      try {
        // Use onSnapshot for real-time updates
        unsubscribeFromSnapshot = onSnapshot(videoProgressRef, (docSnap) => {
          if (docSnap.exists()) {
            const data = docSnap.data();
            setWatchedIntervals(data.watchedIntervals || []);
            setLastWatchedPosition(data.lastWatchedPosition || 0);
            console.log("Progress loaded successfully:", data);

            // Resume video playback if the video element is ready
            if (videoRef.current && data.lastWatchedPosition > 0) {
              videoRef.current.currentTime = data.lastWatchedPosition;
              // Optionally, play the video automatically, but user interaction is generally preferred
              // videoRef.current.play();
            }
          } else {
            console.log("No saved progress found for this video.");
            setWatchedIntervals([]);
            setLastWatchedPosition(0);
          }
        }, (error) => {
          console.error("Error listening to progress updates:", error);
        });
      } catch (error) {
        console.error("Error setting up onSnapshot listener:", error);
      }
    }
    // Cleanup function for useEffect
    return () => {
      if (unsubscribeFromSnapshot) {
        unsubscribeFromSnapshot(); // This will now correctly call the unsubscribe function returned by onSnapshot
      }
    };
  }, [isAuthReady, userId, videoId]); // Depend on userId, isAuthReady, and videoId

  // Effect to save progress whenever watchedIntervals or currentVideoTime changes significantly
  useEffect(() => {
    // Debounce saving to Firestore to avoid too many writes
    const handler = setTimeout(() => {
      saveProgress();
    }, 1000); // Save every 1 second of inactivity or significant change

    return () => {
      clearTimeout(handler);
    };
  }, [watchedIntervals, currentVideoTime, saveProgress]);


  // --- Video Event Handlers ---

  // Handle video metadata loaded (duration available)
  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setVideoDuration(videoRef.current.duration);
      // Set video to last watched position after metadata loads
      if (lastWatchedPosition > 0) {
        videoRef.current.currentTime = lastWatchedPosition;
      }
    }
  };

  // Handle video play event
  const handlePlay = () => {
    setIsPlaying(true);
    currentSegmentStart.current = videoRef.current.currentTime;
    lastTimeUpdate.current = videoRef.current.currentTime;
  };

  // Handle video pause event
  const handlePause = () => {
    setIsPlaying(false);
    // When paused, finalize the current segment
    addWatchedSegment(currentSegmentStart.current, videoRef.current.currentTime);
  };

  // Handle video ended event
  const handleEnded = () => {
    setIsPlaying(false);
    // When video ends, mark the entire duration as watched
    addWatchedSegment(currentSegmentStart.current, videoDuration);
    // Optionally, set progress to 100%
    setProgressPercentage(100);
  };

  // Handle video time update event (fires frequently)
  const handleTimeUpdate = () => {
    if (videoRef.current) {
      const currentTime = videoRef.current.currentTime;
      const playbackRate = videoRef.current.playbackRate; // To detect fast-forwarding

      setCurrentVideoTime(currentTime);

      // If playing and not seeking, and time has advanced
      if (isPlaying && !isSeeking.current && currentTime > lastTimeUpdate.current) {
        // Check for significant jumps (fast-forwarding)
        if (currentTime - lastTimeUpdate.current > 1.5 * playbackRate) { // If jump is more than 1.5 seconds * playback rate
          // User jumped, so finalize the previous segment
          addWatchedSegment(currentSegmentStart.current, lastTimeUpdate.current);
          // Start a new segment from the current jumped position
          currentSegmentStart.current = currentTime;
        }
        // Otherwise, just extend the current segment implicitly
      }
      lastTimeUpdate.current = currentTime;
    }
  };

  // Handle video seeking start
  const handleSeeking = () => {
    isSeeking.current = true;
    // When seeking, finalize the current segment before the jump
    if (isPlaying) {
      addWatchedSegment(currentSegmentStart.current, lastTimeUpdate.current);
    }
  };

  // Handle video seeking end
  const handleSeeked = () => {
    isSeeking.current = false;
    // After seeking, if playing, start a new segment from the new position
    if (isPlaying) {
      currentSegmentStart.current = videoRef.current.currentTime;
      lastTimeUpdate.current = videoRef.current.currentTime;
    } else {
      // If paused after seek, ensure the position is updated for resume
      setLastWatchedPosition(videoRef.current.currentTime);
    }
  };

  // --- Progress Tracking Logic ---

  // Function to add a new watched segment and merge intervals
  const addWatchedSegment = useCallback((start, end) => {
    // Ensure valid segment
    if (start >= end) return;

    setWatchedIntervals(prevIntervals => {
      const newIntervals = [...prevIntervals, { start: Math.floor(start), end: Math.ceil(end) }];
      return mergeAndSortIntervals(newIntervals);
    });
  }, []);

  // Helper function to merge and sort intervals
  const mergeAndSortIntervals = (intervals) => {
    if (intervals.length === 0) return [];

    // Sort intervals by their start time
    intervals.sort((a, b) => a.start - b.start);

    const merged = [];
    let currentMergedInterval = { ...intervals[0] };

    for (let i = 1; i < intervals.length; i++) {
      const nextInterval = intervals[i];

      // If the current interval overlaps with the next, merge them
      if (currentMergedInterval.end >= nextInterval.start) {
        currentMergedInterval.end = Math.max(currentMergedInterval.end, nextInterval.end);
      } else {
        // No overlap, add the current merged interval and start a new one
        merged.push(currentMergedInterval);
        currentMergedInterval = { ...nextInterval };
      }
    }
    // Add the last merged interval
    merged.push(currentMergedInterval);
    return merged;
  };

  // Calculate unique progress percentage
  useEffect(() => {
    if (videoDuration === 0) {
      setProgressPercentage(0);
      return;
    }

    let totalUniqueDuration = 0;
    for (const interval of watchedIntervals) {
      totalUniqueDuration += (interval.end - interval.start);
    }

    // Ensure percentage doesn't exceed 100%
    const calculatedPercentage = Math.min(100, (totalUniqueDuration / videoDuration) * 100);
    setProgressPercentage(calculatedPercentage);
  }, [watchedIntervals, videoDuration]);


  return (
    <div className="min-h-screen bg-gray-100 flex flex-col items-center justify-center p-4 font-sans">
      <div className="w-full max-w-4xl bg-white rounded-lg shadow-xl p-6">
        <h1 className="text-3xl font-bold text-gray-800 mb-6 text-center">Lecture Video Progress Tracker</h1>

        {/* Display User ID for debugging/multi-user context */}
        {userId && (
          <div className="text-sm text-gray-600 mb-4 text-center">
            User ID: <span className="font-mono bg-gray-200 px-2 py-1 rounded">{userId}</span>
          </div>
        )}
        {!userId && isAuthReady && (
          <div className="text-sm text-red-600 mb-4 text-center">
            Not authenticated. Progress will not be saved.
          </div>
        )}

        {/* Video Player Section */}
        <div className="mb-6 rounded-md overflow-hidden">
          <video
            ref={videoRef}
            src="https://www.w3schools.com/html/mov_bbb.mp4" // Example video URL
            controls
            className="w-full rounded-md"
            onLoadedMetadata={handleLoadedMetadata}
            onPlay={handlePlay}
            onPause={handlePause}
            onEnded={handleEnded}
            onTimeUpdate={handleTimeUpdate}
            onSeeking={handleSeeking}
            onSeeked={handleSeeked}
          >
            Your browser does not support the video tag.
          </video>
        </div>

        {/* Progress Display */}
        <div className="bg-blue-100 rounded-full h-8 flex items-center justify-between p-2 mb-4">
          <div className="text-blue-800 font-semibold text-lg ml-2">
            Progress: {progressPercentage.toFixed(2)}%
          </div>
          <div className="w-3/4 h-4 bg-blue-300 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-600 transition-all duration-300 ease-out rounded-full"
              style={{ width: `${progressPercentage}%` }}
            ></div>
          </div>
        </div>

        {/* Current Time and Duration Display */}
        <div className="text-gray-600 text-sm mb-4 text-center">
          Current Time: {currentVideoTime.toFixed(2)}s / Duration: {videoDuration.toFixed(2)}s
        </div>

        {/* Watched Intervals Display (for debugging/visualization) */}
        <div className="bg-gray-50 p-4 rounded-md border border-gray-200">
          <h3 className="text-lg font-semibold text-gray-700 mb-2">Watched Intervals (Unique):</h3>
          <div className="max-h-40 overflow-y-auto text-sm text-gray-600">
            {watchedIntervals.length > 0 ? (
              watchedIntervals.map((interval, index) => (
                <div key={index} className="mb-1">
                  [{interval.start.toFixed(2)}s - {interval.end.toFixed(2)}s]
                </div>
              ))
            ) : (
              <div>No intervals watched yet.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;